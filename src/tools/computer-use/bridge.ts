/**
 * computer_use 闭源桥（2026-08-08）：驱动与执行实现迁入 src/pro/computer-use/
 * （sync-to-public.sh --exclude 'pro/'，不进公开仓）。本文件是开源侧唯一入口。
 *
 * 与 api/pro-registry.ts 同族模式：
 * - 存在性探测走同步 existsSync（工具注册表是同步路径，不能 await）；
 * - 实现加载走变量路径动态 import（绕 tsc 静态存在性检查 / 打包器静态内联）；
 * - 公开构建（无 src/pro/）全部消费方静默降级：工具不注册、状态端点报不可用。
 */

import { existsSync } from 'node:fs'
import type { Tool } from '../types.js'

/** 桥消费的 pro 实现面。类型在开源侧声明（pro 侧 index.ts 按此导出）。 */
export interface ComputerUseImpl {
  createComputerUseTool(options?: Record<string, unknown>): Tool
  createPlatformDriver(platform?: NodeJS.Platform): {
    checkPermissions(): Promise<{ accessibility: boolean; screenRecording: boolean; detail: string }>
  }
  isComputerUsePlatform(platform: NodeJS.Platform): boolean
}

// 候选产物路径：src 形态（tsx 下 .js→.ts 映射可导入，但磁盘上是 .ts，
// existsSync 探测必须带 .ts 变体）与 dist 形态（bundle 进 dist/main.js，
// pro 产物在 dist/pro/computer-use/index.js）。
const IMPORT_URLS = [
  new URL('../../pro/computer-use/index.js', import.meta.url),
  new URL('./pro/computer-use/index.js', import.meta.url),
]
const PROBE_URLS = [
  new URL('../../pro/computer-use/index.ts', import.meta.url), // src 形态
  new URL('./pro/computer-use/index.js', import.meta.url),     // dist 形态
]

/** pro computer-use 实现是否随产物存在（同步探测，供同步注册路径用）。 */
export function computerUseModulePresent(): boolean {
  for (const url of PROBE_URLS) {
    try {
      if (existsSync(url)) return true
    } catch {
      // 继续探测下一候选
    }
  }
  return false
}

let cached: ComputerUseImpl | null = null

/** 动态加载 pro 实现；公开构建返回 null。只缓存成功——失败允许下次重试。 */
export async function loadComputerUseImpl(): Promise<ComputerUseImpl | null> {
  if (cached) return cached
  for (const url of IMPORT_URLS) {
    try {
      const mod = (await import(url.href)) as ComputerUseImpl
      cached = mod
      return mod
    } catch {
      // 尝试下一候选；全部失败则静默降级
    }
  }
  return null
}

/** 平台判定（2 行，开源侧保留一份——状态端点与桩的 isEnabled 需要同步答案）。 */
export function isComputerUseSupportedPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'win32'
}
