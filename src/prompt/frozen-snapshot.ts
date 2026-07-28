/**
 * 冻结前缀快照的可序列化形态——随会话落盘（`<id>.frozen.json`），
 * resume 时读回经 PromptEngine 的 inheritFrozenFrom 喂给新引擎，
 * 历史 user 消息恢复原始字节 → 服务商前缀缓存 TTL 内 resume 不再
 * byte-0 全 miss（只在新 user 边界断尾）。
 *
 * 独立成模块（零依赖）是为了让 session-persist 直接引用而不产生
 * prompt/engine ↔ agent/session-persist 的循环依赖。
 */

export interface FrozenSnapshotData {
  v: 1
  frozenUserMerged: Array<[string, string[]]>
  frozenPendingMerged: Array<[string, string]>
  firstUserKey: string | null
  collapseWatermark: number
  collapseTokenStep: number
}

/** 盘存快照的最小形状校验（坏文件/旧版本 → undefined，调用方降级为全量重建）。 */
export function parseFrozenSnapshotData(raw: unknown): FrozenSnapshotData | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const d = raw as Record<string, unknown>
  if (d['v'] !== 1) return undefined
  if (!Array.isArray(d['frozenUserMerged']) || !Array.isArray(d['frozenPendingMerged'])) return undefined
  if (typeof d['collapseWatermark'] !== 'number' || typeof d['collapseTokenStep'] !== 'number') return undefined
  if (d['firstUserKey'] !== null && typeof d['firstUserKey'] !== 'string') return undefined
  return raw as FrozenSnapshotData
}
