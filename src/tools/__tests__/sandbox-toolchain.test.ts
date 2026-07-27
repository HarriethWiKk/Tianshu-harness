import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  toolchainWritableRoots,
  detectedToolchains,
  _resetToolchainCache,
} from '../sandbox-toolchain.js'

/** exists() stub: only the listed paths exist. */
function only(paths: string[]): (p: string) => boolean {
  const set = new Set(paths)
  return p => set.has(p)
}

describe('toolchainWritableRoots', () => {
  beforeEach(() => _resetToolchainCache())

  it('adds cargo roots for a Rust project', () => {
    const roots = toolchainWritableRoots({
      cwd: '/w', home: '/h', platform: 'linux',
      exists: only(['/w/Cargo.toml', '/h/.cargo', '/h/.rustup']),
    })
    assert.deepEqual(roots.sort(), ['/h/.cargo', '/h/.rustup'])
  })

  it('adds Xcode roots for a Tauri project on darwin', () => {
    const roots = toolchainWritableRoots({
      cwd: '/w', home: '/h', platform: 'darwin',
      exists: only([
        '/w/src-tauri/tauri.conf.json',
        '/h/Library/Developer/Xcode/DerivedData',
        '/h/Library/MobileDevice/Provisioning Profiles',
      ]),
    })
    assert.ok(roots.includes('/h/Library/Developer/Xcode/DerivedData'))
    assert.ok(roots.includes('/h/Library/MobileDevice/Provisioning Profiles'))
  })

  it('does NOT add darwin-only roots on linux', () => {
    const roots = toolchainWritableRoots({
      cwd: '/w', home: '/h', platform: 'linux',
      exists: only(['/w/tauri.conf.json', '/h/Library/Developer/Xcode/DerivedData']),
    })
    assert.deepEqual(roots, [])
  })

  it('drops roots that do not exist (bwrap --bind would abort)', () => {
    const roots = toolchainWritableRoots({
      cwd: '/w', home: '/h', platform: 'linux',
      exists: only(['/w/Cargo.toml']), // neither .cargo nor .rustup exist
    })
    assert.deepEqual(roots, [])
  })

  it('returns nothing when no marker matches', () => {
    const roots = toolchainWritableRoots({
      cwd: '/w', home: '/h', platform: 'darwin',
      exists: only(['/h/.cargo']),
    })
    assert.deepEqual(roots, [])
  })

  it('dedupes roots shared by two active rules', () => {
    const roots = toolchainWritableRoots({
      cwd: '/w', home: '/h', platform: 'darwin',
      exists: only([
        '/w/Cargo.toml', '/w/src-tauri/Cargo.toml',
        '/h/.cargo', '/h/.rustup',
      ]),
    })
    assert.equal(new Set(roots).size, roots.length)
  })

  it('caches per (platform, home, cwd)', () => {
    let calls = 0
    const exists = (p: string) => { calls++; return p === '/w/Cargo.toml' || p === '/h/.cargo' }
    const ctx = { cwd: '/w', home: '/h', platform: 'linux' as NodeJS.Platform, exists }
    toolchainWritableRoots(ctx)
    const after = calls
    toolchainWritableRoots(ctx)
    assert.equal(calls, after, 'second call must be served from cache')
  })
})

describe('detectedToolchains', () => {
  it('names the active toolchains for diagnostics', () => {
    const ids = detectedToolchains({
      cwd: '/w', home: '/h', platform: 'darwin',
      exists: only(['/w/Cargo.toml', '/w/pnpm-lock.yaml']),
    })
    assert.deepEqual(ids.sort(), ['pnpm', 'rust'])
  })
})
