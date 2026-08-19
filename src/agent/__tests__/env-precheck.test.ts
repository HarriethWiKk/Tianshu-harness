import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeEnvFacts, formatEnvPrecheckBlock, formatEnvFooter } from '../env-precheck.js'

const GIB = 2 ** 30

describe('probeEnvFacts（真实探针）', () => {
  it('真实 tmpdir 返回正的可用/总量', () => {
    const dir = mkdtempSync(join(tmpdir(), 'env-precheck-'))
    const facts = probeEnvFacts(dir)
    assert.ok(facts.diskFreeBytes! > 0)
    assert.ok(facts.diskTotalBytes! > facts.diskFreeBytes!)
  })

  it('不存在路径静默返回空 facts——预检绝不阻断', () => {
    assert.deepEqual(probeEnvFacts('/no/such/path/__env_precheck__'), {})
  })
})

describe('formatEnvPrecheckBlock（分级提示）', () => {
  it('紧张档（<5 GiB）：⚠ + 降级必答句', () => {
    const block = formatEnvPrecheckBlock({ diskFreeBytes: 1.3 * GIB, diskTotalBytes: 228 * GIB })
    assert.match(block, /── 环境预检（硬约束，评审\/排期前必核）──/)
    assert.match(block, /可用 1\.3 GiB \/ 共 228 GiB/)
    assert.match(block, /⚠ 紧张：GB 级构建\/克隆不可行/)
    assert.match(block, /被环境约束降级过的块，重提\/续跑前必须复检/)
  })

  it('注意档（5–20 GiB）与充裕档（≥20 GiB）', () => {
    assert.match(formatEnvPrecheckBlock({ diskFreeBytes: 17 * GIB }), /注意：仅够单个中型构建/)
    assert.match(formatEnvPrecheckBlock({ diskFreeBytes: 25 * GIB }), /充裕/)
  })

  it('≥10 GiB 取整数显示；facts 空返回空串', () => {
    assert.match(formatEnvPrecheckBlock({ diskFreeBytes: 25.6 * GIB }), /可用 26 GiB/)
    assert.equal(formatEnvPrecheckBlock({}), '')
    assert.equal(formatEnvPrecheckBlock({ diskTotalBytes: 100 * GIB }), '')
  })
})

describe('formatEnvFooter（报告页脚）', () => {
  it('单行环境现状；facts 空返回空串', () => {
    assert.match(formatEnvFooter({ diskFreeBytes: 1.3 * GIB }), /^环境现状：磁盘可用 1\.3 GiB（项目卷）——⚠ 紧张/)
    assert.equal(formatEnvFooter({}), '')
  })
})
