import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readBenchmarkRuns } from './store.js'

/**
 * 测量回路 P2-0 采数卫生：同一 suite 的多次执行用时间戳 nonce 区分文件与
 * 会话目录，避免「同名 store 被两次执行混写」（幽灵轮教训，2026-08-07）。
 * nonce 格式 yyyymmdd-HHmmss，与 Phase 1 旧命名（如 spark-taiyi-20260807.jsonl）
 * 同风格——旧文件按扩展名 .jsonl 纳入查重扫描。
 */
export function benchmarkRunNonce(now: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
}

/** 缺省 store 文件名：runs-<suiteId>-<nonce>.jsonl，与 session-data 目录同 nonce 可关联。 */
export function benchmarkStoreFileName(suiteId: string, now: Date = new Date()): string {
  return `runs-${suiteId}-${benchmarkRunNonce(now)}.jsonl`
}

/** 缺省 session-data 根目录：os.tmpdir()/rivet-bench/<suiteId>-<nonce>（工作区 rsync --delete 不重置）。 */
export function defaultSessionDataDir(suiteId: string, now: Date = new Date()): string {
  return join(tmpdir(), 'rivet-bench', `${suiteId}-${benchmarkRunNonce(now)}`)
}

/**
 * 扫描 dir 下全部 *.jsonl（含 Phase 1 旧命名）统计同 suiteId 的历史行数。
 * 目录不存在或不可读返回 0。无效行由 readBenchmarkRuns 静默跳过。
 */
export function countSuiteRunsInDir(dir: string, suiteId: string): number {
  let names: string[]
  try {
    names = readdirSync(dir).filter(n => n.endsWith('.jsonl'))
  } catch {
    return 0
  }
  let total = 0
  for (const name of names) {
    total += readBenchmarkRuns(join(dir, name), { suiteId }).length
  }
  return total
}
