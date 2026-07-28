import { createWorktreeAsync, removeWorktreeAsync } from './worktree.js'

export interface WorktreeHandle {
  path: string
  branch: string
}

/**
 * Manages git worktrees for write-capable worker sessions.
 * Each worker gets its own worktree with a unique branch,
 * isolated from the primary session's working directory.
 *
 * Worktrees are cleaned up when the worker completes or fails.
 *
 * All git operations are async: `git worktree add/remove` is a full-tree
 * checkout — seconds on large repos — and the hands dispatch/recycle path runs
 * on the same event loop as the TUI, which must not freeze.
 */
export class WorktreeCoordinator {
  private active: Map<string, WorktreeHandle> = new Map()

  constructor(private readonly baseCwd: string) {}

  /**
   * Create a new worktree for a worker session.
   * Cleans up any stale worktree for the same worker id first.
   */
  async create(workerId: string): Promise<WorktreeHandle> {
    // Cleanup any stale worktree for this worker id
    await this.remove(workerId)

    const branch = `rivet-hands-${workerId.slice(0, 8)}`
    const wt = await createWorktreeAsync(this.baseCwd, workerId, branch)
    const handle: WorktreeHandle = { path: wt.path, branch: wt.branch }
    this.active.set(workerId, handle)
    return handle
  }

  /** Remove a worktree by worker id. No-op if not found. */
  async remove(workerId: string): Promise<void> {
    const handle = this.active.get(workerId)
    if (handle) {
      await removeWorktreeAsync(this.baseCwd, handle.path, handle.branch)
      this.active.delete(workerId)
    }
  }

  /** Remove all active worktrees. Best-effort. */
  async cleanupAll(): Promise<void> {
    for (const [id] of this.active) {
      await this.remove(id)
    }
  }

  /** Get the worktree handle for a worker id, if active. */
  getWorktree(workerId: string): WorktreeHandle | undefined {
    return this.active.get(workerId)
  }

  /** Number of currently active worktrees. */
  getActiveCount(): number {
    return this.active.size
  }
}
