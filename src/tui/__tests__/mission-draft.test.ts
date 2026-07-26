import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseMissionDraft, shouldPreviewContract, formatContractPreview } from '../mission-draft.js'

describe('parseMissionDraft（S4 数据层 v1）', () => {
  it('混合输入：mentions → scope，#标签 → criteria，剩余 → objective', () => {
    const d = parseMissionDraft('修复 @file:src/auth/session.ts 的状态恢复 #保持登录 #回归测试')
    assert.deepEqual(d.scope.map(r => `${r.type}:${r.value}`), ['file:src/auth/session.ts'])
    assert.deepEqual(d.criteria, ['保持登录', '回归测试'])
    assert.equal(d.objective, '修复 的状态恢复')
    assert.equal(d.rawText, '修复 @file:src/auth/session.ts 的状态恢复 #保持登录 #回归测试')
  })

  it('无标签时 criteria 为空', () => {
    const d = parseMissionDraft('plain task')
    assert.deepEqual(d.criteria, [])
    assert.equal(d.objective, 'plain task')
    assert.deepEqual(d.scope, [])
  })

  it('quoted 路径与多 mention 保序', () => {
    const d = parseMissionDraft('see @file:"a b.ts" 和 @folder:src')
    assert.deepEqual(d.scope.map(r => r.value), ['a b.ts', 'src'])
  })

  it('``` 代码块内的 # 不抽取为验收标签', () => {
    const d = parseMissionDraft('fix it\n```\n# comment in code\n```\n#real')
    assert.deepEqual(d.criteria, ['real'])
  })

  it('标签去重保序', () => {
    const d = parseMissionDraft('#a #b #a')
    assert.deepEqual(d.criteria, ['a', 'b'])
  })

  it('纯文本 objective 保真（连续空白折叠）', () => {
    const d = parseMissionDraft('  修复   滚动\n回弹  ')
    assert.equal(d.objective, '修复 滚动 回弹')
  })
})

describe('shouldPreviewContract（触发条件）', () => {
  it('有 @引用即触发', () => {
    const d = parseMissionDraft('fix @file:src/a.ts')
    assert.equal(shouldPreviewContract(d, 'fix @file:src/a.ts'), true)
  })

  it('有 #标签即触发', () => {
    const d = parseMissionDraft('fix bug #回归')
    assert.equal(shouldPreviewContract(d, 'fix bug #回归'), true)
  })

  it('长文本（>400 字符）触发', () => {
    const text = 'x'.repeat(401)
    const d = parseMissionDraft(text)
    assert.equal(shouldPreviewContract(d, text), true)
  })

  it('多行（>3 行）触发', () => {
    const text = 'a\nb\nc\nd'
    const d = parseMissionDraft(text)
    assert.equal(shouldPreviewContract(d, text), true)
  })

  it('短自然语言不触发', () => {
    const d = parseMissionDraft('fix the scroll bug')
    assert.equal(shouldPreviewContract(d, 'fix the scroll bug'), false)
  })
})

describe('formatContractPreview（卡片渲染）', () => {
  const theme = { dim: 'DIM', warning: 'WARN', primary: 'PRI', muted: 'MUT' }
  const color = (t: string, c: string) => `<${c}>${t}</>`

  it('全要素：objective/scope/验收/规模/图片/missing//goal 提示', () => {
    const draft = parseMissionDraft('修复 @file:src/a.ts 的状态 #回归')
    const lines = formatContractPreview({
      draft, charCount: 42, imageCount: 2, missingPaths: ['src/a.ts'], cols: 80,
    }, theme, color)
    const text = lines.join('\n')
    assert.ok(text.includes('Mission Contract 预览'))
    assert.ok(text.includes('目标  修复 的状态'))
    assert.ok(text.includes('@file:src/a.ts'))
    assert.ok(text.includes('⚠ 1 个路径不存在'))
    assert.ok(text.includes('#回归'))
    assert.ok(text.includes('42 字符'))
    assert.ok(text.includes('附图 2 张'))
    assert.ok(text.includes('/goal 创建持久目标'), 'criteria>0 时给 /goal 提示行')
    assert.ok(text.includes('⏎ 创建任务') && text.includes('e 返回编辑') && text.includes('Esc 取消'))
  })

  it('无 criteria 不出现 /goal 提示行；无 scope 不渲染范围行', () => {
    const text = 'x'.repeat(500)
    const draft = parseMissionDraft(text)
    const lines = formatContractPreview({ draft, charCount: 500, imageCount: 0, missingPaths: [], cols: 80 }, theme, color)
    const joined = lines.join('\n')
    assert.ok(!joined.includes('/goal'), '无 criteria 无提示行')
    assert.ok(!joined.includes('范围'), '无 scope 无范围行')
    assert.ok(!joined.includes('附图'), '无图片无附图项')
  })
})
