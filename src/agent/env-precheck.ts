/**
 * 星流环境预检（流程钩子，2026-08-18）。
 *
 * playtest 战役教训：LLVM-from-scratch 块（需 10GB+）在方案确认后才于波次中途
 * 发现磁盘只剩 1.3GiB——被迫「降级→重提→再确认」；磁盘腾到 25GiB 后系统也无
 * 感知通道。本模块把磁盘余量这类全局硬约束前移到三个时点：确认前的方案、
 * council 评审目标、每次调用的报告页脚（含 resume——被降级块续跑时自动复检）。
 *
 * 探针只读、异常全静默：环境探测失败绝不阻断点火，块缺席即无此约束可核。
 */
import { statfsSync } from 'node:fs'

export interface EnvFacts {
  /** 项目卷可用字节数（bavail——普通用户实际可分配）。 */
  diskFreeBytes?: number
  /** 项目卷总字节数。 */
  diskTotalBytes?: number
}

/** 分级阈值（GiB）：紧张线 = 单个 GB 级构建都放不下；注意线 = 只够单个中型构建。 */
const DISK_TIGHT_GIB = 5
const DISK_CAUTION_GIB = 20

const GIB = 2 ** 30

function fmtGib(bytes: number): string {
  const gib = bytes / GIB
  return gib >= 10 ? gib.toFixed(0) : gib.toFixed(1)
}

/** 探测项目卷磁盘余量。statfsSync 原生跨平台（macOS/Linux/Windows）；
 *  任何异常（路径不存在/权限/平台怪癖）返回空 facts——预检永不阻断点火。 */
export function probeEnvFacts(cwd: string): EnvFacts {
  try {
    const s = statfsSync(cwd)
    const bsize = typeof s.bsize === 'number' && s.bsize > 0 ? s.bsize : 0
    if (!bsize) return {}
    return {
      diskFreeBytes: (typeof s.bavail === 'number' ? s.bavail : 0) * bsize,
      diskTotalBytes: (typeof s.blocks === 'number' ? s.blocks : 0) * bsize,
    }
  } catch {
    return {}
  }
}

function diskTierLine(facts: EnvFacts): string {
  const freeGib = (facts.diskFreeBytes ?? 0) / GIB
  if (freeGib < DISK_TIGHT_GIB) {
    return `⚠ 紧张：GB 级构建/克隆不可行，涉及任务须降级或换路径`
  }
  if (freeGib < DISK_CAUTION_GIB) {
    return `注意：仅够单个中型构建；多任务并行的大构建需先腾空间`
  }
  return `充裕`
}

/** 评审/排期前的完整环境块（对齐「基线预检」的渲染惯例）。facts 空时返回 ''。 */
export function formatEnvPrecheckBlock(facts: EnvFacts): string {
  if (facts.diskFreeBytes === undefined) return ''
  const total = facts.diskTotalBytes !== undefined ? ` / 共 ${fmtGib(facts.diskTotalBytes)} GiB` : ''
  return [
    '── 环境预检（硬约束，评审/排期前必核）──',
    `磁盘（项目卷）：可用 ${fmtGib(facts.diskFreeBytes)} GiB${total} —— ${diskTierLine(facts)}`,
    '涉及构建/下载/大产物的工作块必须在计划里显式核对上述余量；被环境约束降级过的块，重提/续跑前必须复检。',
  ].join('\n')
}

/** 报告页脚单行（每次调用含 resume 都带——约束复检通道）。facts 空时返回 ''。 */
export function formatEnvFooter(facts: EnvFacts): string {
  if (facts.diskFreeBytes === undefined) return ''
  return `环境现状：磁盘可用 ${fmtGib(facts.diskFreeBytes)} GiB（项目卷）——${diskTierLine(facts)}`
}
