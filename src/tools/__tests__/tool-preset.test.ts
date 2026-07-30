import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { presetIncludes, resolveToolPreset, __resetToolPresetForTest, type ToolPreset } from '../tool-preset.js'
import { createDefaultToolRegistry } from '../default-registry.js'

const BOOTSTRAP_TOOLS = [
  'delegate_task', 'undo', 'delegate_batch', 'team_orchestrate', 'council_convene',
  'recall_capsule', 'recall_general', 'record_general_finding', 'ask_user_question',
  'browser_debug', 'repo_graph', 'related_tests', 'semantic_search', 'apply_patch',
  'session_vitals', 'attack_case', 'plan_task', 'deliver_task', 'update_goal',
] as const

function bootstrapCount(preset: ToolPreset): number {
  // related_tests 与 kernel 重名（覆盖注册），不计入新增
  return BOOTSTRAP_TOOLS.filter(n => n !== 'related_tests' && presetIncludes(preset, n)).length
}

function totalCount(preset: ToolPreset): number {
  return createDefaultToolRegistry([], { preset }).getAll().length + bootstrapCount(preset)
}

describe('presetIncludes', () => {
  it('minimal keeps daily-dev tools and drops heavy/cold ones', () => {
    for (const keep of ['read_file', 'bash', 'grep', 'web_search', 'web_fetch', 'deliver_task', 'delegate_task', 'delegate_batch', 'apply_patch', 'plan_task', 'recall_capsule', 'ask_user_question']) {
      assert.ok(presetIncludes('minimal', keep), `minimal must keep ${keep}`)
    }
    for (const drop of ['council_convene', 'browser_debug', 'attack_case', 'semantic_search', 'repo_graph', 'undo', 'recall_general', 'record_general_finding', 'ast_edit', 'related_tests', 'inspect_project', 'import_resource', 'leave_mark', 'file_info', 'session_vitals', 'update_goal']) {
      assert.ok(!presetIncludes('minimal', drop), `minimal must drop ${drop}`)
    }
  })

  it('frontend = minimal + browser_debug', () => {
    assert.ok(presetIncludes('frontend', 'browser_debug'))
    assert.ok(!presetIncludes('frontend', 'attack_case'))
    assert.ok(!presetIncludes('frontend', 'council_convene'))
  })

  it('full includes everything', () => {
    for (const n of BOOTSTRAP_TOOLS) assert.ok(presetIncludes('full', n), n)
  })
})

describe('assembly counts per preset', () => {
  it('minimal=29 / frontend=30 / full=48（完整装配口径）', () => {
    assert.equal(totalCount('minimal'), 29)
    assert.equal(totalCount('frontend'), 30)
    // 118d0505：monitor 工具（full 档专属）入注册表，full 44 → 45
    // B3：web_crawl/web_map（full 档专属）入注册表，full 45 → 47
    // 视觉副驾：ask_image 无条件注册（各档 +1），28/29/47 → 29/30/48
    assert.equal(totalCount('full'), 48)
  })

  it('kernel(default-registry) minimal 排除 ast_edit/inspect_project/related_tests/import_resource/leave_mark', () => {
    const reg = createDefaultToolRegistry([], { preset: 'minimal' })
    for (const drop of ['ast_edit', 'inspect_project', 'related_tests', 'import_resource', 'leave_mark']) {
      assert.ok(!reg.has(drop), drop)
    }
    for (const keep of ['web_search', 'web_fetch', 'repo_map', 'ast_grep']) {
      assert.ok(reg.has(keep), keep)
    }
  })

  it('env force-on：RIVET_IMPORT_RESOURCE=1 在 minimal 下补入', () => {
    process.env.RIVET_IMPORT_RESOURCE = '1'
    try {
      const reg = createDefaultToolRegistry([], { preset: 'minimal' })
      assert.ok(reg.has('import_resource'))
    } finally {
      delete process.env.RIVET_IMPORT_RESOURCE
    }
  })
})

describe('resolveToolPreset precedence', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tool-preset-'))
    __resetToolPresetForTest()
    delete process.env.RIVET_TOOL_PRESET
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.RIVET_TOOL_PRESET
    __resetToolPresetForTest()
  })

  it('defaults to minimal with no env and no config', () => {
    assert.equal(resolveToolPreset(dir), 'minimal')
  })

  it('project .rivet-config.json tools.preset wins over default', () => {
    writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({ tools: { preset: 'full' } }))
    __resetToolPresetForTest()
    assert.equal(resolveToolPreset(dir), 'full')
  })

  it('nested cwd walks up to the project config', () => {
    writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({ tools: { preset: 'frontend' } }))
    mkdirSync(join(dir, 'src', 'x'), { recursive: true })
    __resetToolPresetForTest()
    assert.equal(resolveToolPreset(join(dir, 'src', 'x')), 'frontend')
  })

  it('RIVET_TOOL_PRESET env wins over project config', () => {
    writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({ tools: { preset: 'full' } }))
    process.env.RIVET_TOOL_PRESET = 'frontend'
    __resetToolPresetForTest()
    assert.equal(resolveToolPreset(dir), 'frontend')
  })

  it('invalid values fall back to minimal', () => {
    writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({ tools: { preset: 'huge' } }))
    __resetToolPresetForTest()
    assert.equal(resolveToolPreset(dir), 'minimal')
  })
})

// 读侧必须与写侧（saveToolPresetConfig → userConfigPath）同源。曾经读的是
// defaultRivetHome()，桌面端便携模式 / 自定义存储路径下设置页改档位静默无效。
describe('resolveToolPreset honors the active data root', () => {
  let dir: string
  let home: string
  let prevHome: string | undefined
  let prevConfigPath: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tool-preset-cwd-'))
    home = mkdtempSync(join(tmpdir(), 'tool-preset-home-'))
    prevHome = process.env.RIVET_HOME
    prevConfigPath = process.env.RIVET_CONFIG_PATH
    delete process.env.RIVET_TOOL_PRESET
    delete process.env.RIVET_CONFIG_PATH
    __resetToolPresetForTest()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    if (prevConfigPath === undefined) delete process.env.RIVET_CONFIG_PATH
    else process.env.RIVET_CONFIG_PATH = prevConfigPath
    delete process.env.RIVET_TOOL_PRESET
    __resetToolPresetForTest()
  })

  it('RIVET_HOME 下的 config.json tools.preset 生效', () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ tools: { preset: 'frontend' } }))
    process.env.RIVET_HOME = home
    __resetToolPresetForTest()
    assert.equal(resolveToolPreset(dir), 'frontend')
  })

  it('RIVET_CONFIG_PATH 直指某个文件时也生效', () => {
    const explicit = join(home, 'elsewhere.json')
    writeFileSync(explicit, JSON.stringify({ tools: { preset: 'full' } }))
    process.env.RIVET_CONFIG_PATH = explicit
    __resetToolPresetForTest()
    assert.equal(resolveToolPreset(dir), 'full')
  })

  it('项目配置仍然压过用户配置', () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ tools: { preset: 'full' } }))
    writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({ tools: { preset: 'frontend' } }))
    process.env.RIVET_HOME = home
    __resetToolPresetForTest()
    assert.equal(resolveToolPreset(dir), 'frontend')
  })

  it('数据根下没有 config.json 时回落 minimal', () => {
    process.env.RIVET_HOME = home
    __resetToolPresetForTest()
    assert.equal(resolveToolPreset(dir), 'minimal')
  })
})
