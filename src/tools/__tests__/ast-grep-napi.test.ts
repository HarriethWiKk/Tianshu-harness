import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { loadAstGrepNapi, type NapiModule } from '../ast-grep-napi.js'

/** 造一个带 code 的 Error，模仿 Node 的模块解析失败。 */
function errWithCode(message: string, code: string): Error {
  const e = new Error(message)
  ;(e as Error & { code?: string }).code = code
  return e
}

describe('loadAstGrepNapi', () => {
  it('成功路径返回模块本身', async () => {
    const stub = { Lang: {} } as unknown as NapiModule
    const r = await loadAstGrepNapi(async () => stub)
    assert.equal(r.ok, true)
    assert.equal(r.ok && r.napi, stub)
  })

  it('真·未安装：保留安装指引，同时带出原始错误（不再被裸 catch 吞掉）', async () => {
    const raw = "Cannot find package '@ast-grep/napi' imported from /x/y.js"
    const r = await loadAstGrepNapi(async () => { throw errWithCode(raw, 'ERR_MODULE_NOT_FOUND') })

    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.message, /npm install @ast-grep\/napi/)
    assert.ok(r.message.includes(raw), '原始错误必须出现在消息里，否则无从诊断')
  })

  it('装了但加载失败：不得谎报「未安装」，必须带出真因', async () => {
    // 07-27 的 6 个 worker 报「未安装 @ast-grep/napi」，而依赖装着且主进程 import
    // 成功（196ms）——真因被 `catch {}` 吞了。这类失败（原生 dlopen 失败、
    // 平台包缺失、沙箱阻断）必须与「未安装」区分，否则永远查不出来。
    const raw = 'dlopen(.../napi.darwin-arm64.node, 0x0001): tried: ... (not a mach-o file)'
    const r = await loadAstGrepNapi(async () => { throw new Error(raw) })

    assert.equal(r.ok, false)
    if (r.ok) return
    assert.ok(!/未安装/.test(r.message), `加载失败不得归因为「未安装」：${r.message}`)
    assert.ok(r.message.includes(raw), '原始错误必须出现在消息里')
  })

  it('非 Error 抛出物也要可读，不得变成 [object Object]', async () => {
    const r = await loadAstGrepNapi(async () => { throw 'plain string failure' })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.ok(r.message.includes('plain string failure'))
  })
})
