import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, getVisionModelConfig, setVisionModelConfig } from '../manager.js'

describe('vision model config', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-vision-config-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns null when no vision model is configured', () => {
    assert.equal(getVisionModelConfig(), null)
  })

  it('persists provider + model and round-trips through loadConfig', () => {
    const saved = setVisionModelConfig({ provider: 'minimax', model: 'MiniMax-M3' })
    assert.deepEqual(saved, { provider: 'minimax', model: 'MiniMax-M3', maxTokens: 1024 })
    assert.deepEqual(loadConfig().agent.visionModel, saved)
    assert.deepEqual(getVisionModelConfig(), saved)
  })

  it('persists optional prompt and maxTokens', () => {
    const saved = setVisionModelConfig({
      provider: 'glm',
      model: 'glm-5.2',
      prompt: 'Describe the screenshot in Chinese',
      maxTokens: 512,
    })
    assert.deepEqual(saved, {
      provider: 'glm',
      model: 'glm-5.2',
      prompt: 'Describe the screenshot in Chinese',
      maxTokens: 512,
    })
    assert.deepEqual(getVisionModelConfig(), saved)
  })

  it('clears the bridge when passed null', () => {
    setVisionModelConfig({ provider: 'glm', model: 'glm-5.2' })
    assert.equal(getVisionModelConfig()?.provider, 'glm')
    const cleared = setVisionModelConfig(null)
    assert.equal(cleared, null)
    assert.equal(loadConfig().agent.visionModel, undefined)
  })

  // fallback 的三态：省略=保留、null=清除、对象=设置。省略即保留是为了两个界面
  // （桌面端 / TUI 面板 / 手写配置）轮流写同一份配置时，后写的那个不会抹掉自己不
  // 显示的字段——早期整体替换让"保存一下别的项"就吞掉了备用识图桥。
  it('keeps an existing fallback when the payload omits it', () => {
    setVisionModelConfig({
      provider: 'minimax',
      model: 'MiniMax-M3',
      fallback: { provider: 'glm', model: 'glm-5.2' },
    })
    const saved = setVisionModelConfig({ provider: 'minimax', model: 'MiniMax-M3', maxTokens: 2048 })
    assert.deepEqual(saved?.fallback, { provider: 'glm', model: 'glm-5.2' }, '不提到它就不该删它')
    assert.equal(saved?.maxTokens, 2048)
  })

  it('clears the fallback only on an explicit null', () => {
    setVisionModelConfig({
      provider: 'minimax',
      model: 'MiniMax-M3',
      fallback: { provider: 'glm', model: 'glm-5.2' },
    })
    const saved = setVisionModelConfig({ provider: 'minimax', model: 'MiniMax-M3', fallback: null })
    assert.equal(saved?.fallback, undefined)
    assert.equal(loadConfig().agent.visionModel?.fallback, undefined)
  })

  it('replaces the fallback when a new one is given', () => {
    setVisionModelConfig({ provider: 'minimax', model: 'MiniMax-M3', fallback: { provider: 'glm', model: 'glm-5.2' } })
    const saved = setVisionModelConfig({
      provider: 'minimax',
      model: 'MiniMax-M3',
      fallback: { provider: 'deepseek', model: 'deepseek-vl' },
    })
    assert.deepEqual(saved?.fallback, { provider: 'deepseek', model: 'deepseek-vl' })
  })

  it('rejects a malformed fallback instead of silently dropping it', () => {
    assert.throws(() => setVisionModelConfig({
      provider: 'minimax',
      model: 'MiniMax-M3',
      fallback: { provider: 'glm' },
    }))
  })

  it('treats empty provider/model as a clear and rejects malformed payloads', () => {
    setVisionModelConfig({ provider: 'minimax', model: 'MiniMax-M3' })
    assert.equal(getVisionModelConfig()?.provider, 'minimax')

    // Empty provider/model clears the bridge (UI "Clear" path).
    const cleared = setVisionModelConfig({ provider: '', model: 'MiniMax-M3' } as unknown as Record<string, unknown>)
    assert.equal(cleared, null)
    assert.equal(loadConfig().agent.visionModel, undefined)

    // Missing model or invalid maxTokens are rejected.
    assert.throws(() => setVisionModelConfig({ provider: 'minimax' } as unknown as Record<string, unknown>))
    assert.throws(() => setVisionModelConfig({ provider: 'minimax', model: 'MiniMax-M3', maxTokens: 0 } as unknown as Record<string, unknown>))
  })
})
