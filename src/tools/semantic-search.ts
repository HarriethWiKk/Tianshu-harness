import type { Tool, ToolCallParams } from './types.js'
import { ensureSemanticIndex } from '../search/semantic-index.js'
import { createEmbeddingProvider } from '../search/embedding-provider.js'
import { shapeSurgicalContext } from '../repo/surgical-shaper.js'
import type { SurgicalBlock } from '../repo/surgical-shaper.js'

/** 空结果标记——search-pod-hook 靠 includes 识别；改文案必须与 hook 同步。 */
export const SEMANTIC_SEARCH_NO_MATCHES_MARKER = '未找到匹配：'

export interface SemanticSearchHit {
  file: string
  startLine: number
  endLine: number
  text: string
  score: number
}

/** 单块展示字符上限（原 fmt 的 slice(0, 300) 语义，截断交给 shaper 统一做）。 */
const CHUNK_MAX_CHARS = 300

/**
 * 命中结果经 surgical-shaper 整形后再格式化（wave4 T8 接线）：
 * per-file ≤20% 防单文件垄断、非测试查询时测试文件 ≤15%、
 * 多词泛化查询无强佐证时附低置信标注。
 * 空命中返回空数组——no-matches 标记语义仍归调用方。
 */
export function shapeSearchHits(
  hits: SemanticSearchHit[],
  query: string,
  limit: number,
): { formatted: string[]; note: string | null } {
  if (hits.length === 0) return { formatted: [], note: null }
  const byId = new Map<string, SemanticSearchHit>()
  const blocks: SurgicalBlock[] = hits.map(h => {
    const id = `${h.file}:${h.startLine}-${h.endLine}`
    byId.set(id, h)
    return {
      id,
      filePath: h.file,
      name: h.file.split('/').pop() ?? h.file,
      kind: 'chunk',
      content: h.text,
      score: h.score,
    }
  })
  const shaped = shapeSurgicalContext(blocks, {
    maxNodes: limit,
    maxCodeBlocks: limit,
    maxCodeBlockSize: CHUNK_MAX_CHARS,
    query,
    isTestQuery: /\b(test|tests|spec|specs|fixture|fixtures|mock|mocks)\b/i.test(query),
  })
  const formatted = shaped.blocks.map(b => {
    const h = byId.get(b.id)!
    return `${h.file}:${h.startLine}-${h.endLine} (score ${h.score.toFixed(3)})\n${b.content}`
  })
  return { formatted, note: shaped.lowConfidenceNote }
}

export const SEMANTIC_SEARCH_TOOL: Tool = {
  definition: {
    name: 'semantic_search',
    description: `按语义搜索代码库。配置了 embedding provider 时，混合使用 BM25（词法）与 embedding 向量检索（RRF 融合）；离线时降级为纯 BM25。

当 grep/glob 无法按概念找到代码（如 "authentication middleware"、"session persistence"）时使用。
结果疑似过期时，用 /index 或设 rebuild: true 重建索引。`,
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '自然语言或关键词查询' },
        limit: { type: 'integer', description: '最大结果数（默认 10）' },
        rebuild: { type: 'boolean', description: '搜索前强制重建索引' },
      },
      required: ['query'],
    },
  },

  async execute(params: ToolCallParams) {
    const query = String(params.input.query ?? '').trim()
    if (!query) {
      return { content: '错误：需要提供 query', isError: true }
    }

    const limit = Math.min(Number(params.input.limit) || 10, 25)
    const idx = ensureSemanticIndex(params.cwd, createEmbeddingProvider())

    // 整形（per-file/测试降权/低置信标注）后拼正文——三条路径共用。
    const render = (hits: SemanticSearchHit[]) => {
      const { formatted, note } = shapeSearchHits(hits, query, limit)
      const body = formatted.join('\n\n---\n\n')
      return { count: formatted.length, body: note ? `${body}\n\n${note}` : body }
    }

    if (params.input.rebuild === true) {
      const stats = idx.rebuild()
      const { hits, backend } = await idx.searchHybrid(query, limit)
      if (hits.length === 0) {
        return { content: `索引已重建（${stats.indexed} 个文件）。${SEMANTIC_SEARCH_NO_MATCHES_MARKER}${query}` }
      }
      const r = render(hits)
      return { content: `索引已重建（${stats.indexed} 个文件，${backend}）。前 ${r.count} 条匹配：\n\n${r.body}` }
    }

    // Auto-incremental update when stale (lazy refresh)
    if (idx.isStale()) {
      const update = idx.incrementalUpdate()
      const refreshNote = update.fallbackRebuild
        ? `（全量重建：${update.reindexed} 个文件）`
        : `（${update.reindexed} 个已变更，${update.removed} 个已移除）`
      const { hits, backend } = await idx.searchHybrid(query, limit)
      if (hits.length === 0) {
        return { content: `索引已刷新${refreshNote}。${SEMANTIC_SEARCH_NO_MATCHES_MARKER}${query}` }
      }
      const r = render(hits)
      return { content: `索引已刷新${refreshNote}（${backend}）。前 ${r.count} 条匹配：\n\n${r.body}` }
    }

    const { hits, backend } = await idx.searchHybrid(query, limit)
    if (hits.length === 0) {
      return { content: `${SEMANTIC_SEARCH_NO_MATCHES_MARKER}${query}\n可尝试 rebuild: true 或运行 /index` }
    }
    const r = render(hits)
    return { content: `前 ${r.count} 条匹配（${backend}）：\n\n${r.body}` }
  },

  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}
