/**
 * Push an auto-fix worker's diff artifact back to a PR's head branch.
 *
 * Worker worktrees are reaped on completion (hands-session.ts finally), so the
 * durable output is the diff artifact. To land it we rebuild a detached
 * worktree on origin/<headRefName>, `git apply` the diff (3way fallback),
 * commit and push — fast-forward only, never force. Fork PRs without push
 * permission fail at the push stage with git's stderr surfaced.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnGitSync } from '../tools/spawn-git.js'
import { createWorktreeAt, removeWorktree, commitAll } from '../agent/worktree.js'

export interface PushFixResult {
  ok: boolean
  /** Stage reached — helps the UI explain where a failure happened. */
  stage?: 'fetch' | 'worktree' | 'apply' | 'commit' | 'push'
  error?: string
  /** Commit sha of the landed fix (undefined when nothingToCommit). */
  sha?: string
  /** Diff applied to zero changes (e.g. already fixed upstream) — treated as success. */
  nothingToCommit?: boolean
}

/** Refname charset guard (args are passed as an array, but reject junk early). */
const REFNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

export async function pushFixToPrBranch(cwd: string, headRefName: string, diff: string): Promise<PushFixResult> {
  if (!REFNAME_RE.test(headRefName) || headRefName.includes('..')) {
    return { ok: false, stage: 'fetch', error: `invalid headRefName: ${headRefName}` }
  }
  if (!diff.trim()) return { ok: false, stage: 'apply', error: 'empty diff artifact' }

  const fetch = spawnGitSync(['fetch', 'origin', headRefName], { cwd, timeout: 60_000 })
  if (fetch.status !== 0) {
    return { ok: false, stage: 'fetch', error: (fetch.stderr || fetch.stdout).trim() || 'git fetch failed' }
  }

  // Detached worktree directly on origin/<headRefName> — the push is always
  // fast-forward relative to the PR branch tip we just fetched.
  const wtPath = mkdtempSync(join(tmpdir(), 'rivet-prfix-'))
  try {
    try {
      createWorktreeAt(cwd, wtPath, `origin/${headRefName}`)
    } catch (e) {
      return { ok: false, stage: 'worktree', error: (e as Error).message }
    }

    // Patch file lives OUTSIDE the tree so `commitAll`'s `git add -A` can't pick it up.
    const patchPath = `${wtPath}.patch`
    writeFileSync(patchPath, diff)
    let apply = spawnGitSync(['apply', '--whitespace=nowarn', patchPath], { cwd: wtPath, timeout: 30_000 })
    if (apply.status !== 0) {
      // Content-level drift between the worker's base and the PR head — retry with 3way.
      apply = spawnGitSync(['apply', '--3way', '--whitespace=nowarn', patchPath], { cwd: wtPath, timeout: 30_000 })
    }
    try { rmSync(patchPath, { force: true }) } catch {}
    if (apply.status !== 0) {
      return { ok: false, stage: 'apply', error: (apply.stderr || apply.stdout).trim() || 'git apply failed (conflicts)' }
    }

    const commit = commitAll(wtPath, `fix: CI failures on ${headRefName} (rivet auto-fix)`)
    if (!commit.ok) return { ok: false, stage: 'commit', error: commit.error ?? 'commit failed' }
    if (commit.nothingToCommit) return { ok: true, nothingToCommit: true }

    const push = spawnGitSync(['push', 'origin', `HEAD:${headRefName}`], {
      cwd: wtPath,
      timeout: 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    if (push.status !== 0) {
      return { ok: false, stage: 'push', error: (push.stderr || push.stdout).trim() || 'git push failed' }
    }
    return { ok: true, sha: commit.sha }
  } finally {
    removeWorktree(cwd, wtPath)
    try { rmSync(wtPath, { recursive: true, force: true }) } catch {}
  }
}
