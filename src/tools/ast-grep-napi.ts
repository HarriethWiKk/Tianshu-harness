/**
 * Shared loader for the `@ast-grep/napi` native addon (used by ast_grep and
 * ast_edit).
 *
 * Both tools used to inline `try { await import(...) } catch { return '未安装…' }`.
 * That bare catch asserted a cause it had not established: on 2026-07-27 six
 * worker sessions reported "未安装 @ast-grep/napi" (7/7 calls) while the package
 * was in fact installed since 06-27 and imported fine from the main process in
 * 196ms. The real failure — whatever it was (missing platform sub-package,
 * dlopen refused, sandbox) — was discarded along with the error object, leaving
 * nothing to diagnose and pointing the operator at a reinstall that fixes
 * nothing.
 *
 * So: keep the install hint only for genuine resolution failures, and always
 * surface the original message.
 */

export type NapiModule = typeof import('@ast-grep/napi')

export type NapiLoadResult =
  | { ok: true; napi: NapiModule }
  | { ok: false; message: string }

/**
 * Node reports an unresolvable specifier as ERR_MODULE_NOT_FOUND (ESM) or
 * MODULE_NOT_FOUND (CJS). Anything else means the package resolved but failed
 * to initialize — a different problem with a different fix.
 */
function isModuleNotFound(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND'
}

export async function loadAstGrepNapi(
  importer: () => Promise<NapiModule> = () => import('@ast-grep/napi'),
): Promise<NapiLoadResult> {
  try {
    return { ok: true, napi: await importer() }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    if (isModuleNotFound(err)) {
      return {
        ok: false,
        message: '错误：未安装 @ast-grep/napi（或缺少当前平台的原生子包）。'
          + '请运行：npm install @ast-grep/napi'
          + `\n原始错误：${detail}`,
      }
    }
    return {
      ok: false,
      message: '错误：@ast-grep/napi 已安装但加载失败——原生插件无法初始化，'
        + '常见于平台/架构不匹配、沙箱阻断 dlopen、或安装残缺。'
        + `\n原始错误：${detail}`
        + '\n本次请改用 grep 完成搜索；修复可试：npm rebuild @ast-grep/napi',
    }
  }
}
