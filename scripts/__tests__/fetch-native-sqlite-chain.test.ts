import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * 安装链契约（「不能随便降级」）：fetch-native-sqlite.js 必须穷尽一切安装手段
 * 之后才落失败标记走降级。链路 = 复用已有产物 → 4 路预编译镜像 → 源码编译兜底
 * → 失败标记。启动自愈（native-resolver）以 RIVET_FETCH_SKIP_COMPILE=1 调用，
 * 只走下载链不编译——启动路径不能卡数分钟在编译上。
 */
const src = readFileSync(new URL('../fetch-native-sqlite.js', import.meta.url), 'utf8')

test('预编译镜像四路齐备：npmmirror registry / npmmirror CDN 直连 / kkgithub / GitHub 直连', () => {
  assert.match(src, /registry\.npmmirror\.com\/-\/binary\/better-sqlite3/)
  // CDN 直连 = registry 302 的最终目标，registry 域名故障/被墙时的独立通路
  assert.match(src, /cdn\.npmmirror\.com\/binaries\/better-sqlite3/)
  assert.match(src, /kkgithub\.com\/WiseLibs\/better-sqlite3/)
  assert.match(src, /github\.com\/WiseLibs\/better-sqlite3/)
  const mirrorCount = (src.match(/name: '/g) ?? []).length
  assert.ok(mirrorCount >= 4, `镜像应 ≥4 路，实得 ${mirrorCount}`)
})

test('镜像全败后走源码编译兜底（npm install --no-save），成功同样清失败标记', () => {
  assert.match(src, /npm install better-sqlite3@\$\{version\} --no-save --no-audit --no-fund/)
  // 编译兜底成功路径必须与下载成功同等待遇：拷到 dist/native + 清标记 + exit 0
  const compileBlock = src.slice(src.indexOf('trying source build'), src.indexOf('5. 全部失败'))
  assert.match(compileBlock, /clearFailedMarker\(\)/, '编译成功也要清 .fetch-failed')
  assert.match(compileBlock, /copyFileSync\(NODE_MODULES_NATIVE, TARGET\)/)
})

test('编译兜底受 RIVET_FETCH_SKIP_COMPILE 门控（启动自愈只下载不编译）', () => {
  assert.match(src, /RIVET_FETCH_SKIP_COMPILE/)
})

test('失败标记语义不变：全链失败写入 {ts,error}，成功路径清除', () => {
  assert.match(src, /writeFailedMarker\(lastError\)/)
  assert.match(src, /function clearFailedMarker/)
  const clearCalls = (src.match(/clearFailedMarker\(\)/g) ?? []).length
  assert.ok(clearCalls >= 3, `三条成功路径（已有产物/复用 node_modules/下载或编译成功）都应清标记，实得 ${clearCalls}`)
})

test('废弃指引不得回潮：输出文案中不再出现 windows-build-tools / npm rebuild better-sqlite3 -g', () => {
  // 只断言实际输出行（console.*）——注释里的历史说明允许保留
  const outputLines = src.split('\n').filter(l => /console\.(warn|log|error)\(/.test(l)).join('\n')
  assert.doesNotMatch(outputLines, /windows-build-tools/)
  assert.doesNotMatch(outputLines, /npm rebuild better-sqlite3 -g/)
  assert.match(outputLines, /fetch-native-sqlite\.js/, '输出文案应指向重跑本脚本的真实指引')
})
