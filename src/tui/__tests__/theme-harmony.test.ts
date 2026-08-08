/**
 * 主题调和护栏（2026-08-07 配色优化沉淀的契约）。
 *
 * 背景：多套主题曾发生「语义撞车」——pastel primary/success 同色相薄荷绿
 * （cr 1.06）、light-ansi secondary==success 同值绿、dawn 四个 token 同值金、
 * tianshu 金簇（primary≈warning≈toolTest≈toolDelegate）等。共同特征：不同
 * 语义的 token 拿到等值颜色，工具族色编码/警告层级整个塌掉而没有任何测试报警。
 *
 * 本文件把「语义色对必须可区分」锁成契约。注意不等值 ≠ 够和谐（色相距离
 * 仍可能太近），但不等值是底线——所有被撞穿的现场首先都是等值。
 *
 * 刻意豁免：
 * - pulseActive==primary / pulseAlert==error 是全仓惯例（attention 镜像语义色）。
 * - toolEdit==secondary / toolTest==success / toolDelegate==warning 是
 *   makeToolColor 的默认映射，属设计而非撞车。
 * - fallback 16 色轨色域贫困：userColor/error 等对在部分主题刻意共色
 *   （如 claude 移植版全 redBright），fallback 只守四对核心语义。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { THEME_NAMES, THEMES } from '../theme.js'
import type { RivetTheme } from '../theme.js'

type Token = keyof Pick<
  RivetTheme,
  'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'userColor'
>

function assertPairDistinct(theme: RivetTheme, track: string, name: string, a: Token, b: Token) {
  assert.notEqual(
    theme[a].toLowerCase(),
    theme[b].toLowerCase(),
    `${name} (${track}): ${a} 与 ${b} 等值 ${theme[a]}——语义撞车`,
  )
}

const BOTH_TRACK_PAIRS: [Token, Token][] = [
  ['primary', 'success'],   // pastel: 薄荷绿≈薄荷绿
  ['secondary', 'success'], // light-ansi: edit 冒充测试通过
  ['primary', 'warning'],   // tianshu fallback: 同 yellow
  ['warning', 'error'],     // 警告/错误必须可瞬时区分
]

const TRUECOLOR_ONLY_PAIRS: [Token, Token][] = [
  ['secondary', 'warning'], // dawn: 标题金 == 警告金
  ['userColor', 'error'],   // tianshu: 朱砂印 == 朱砂赤
  ['userColor', 'warning'], // dawn: 用户琥珀 ≈ 警告金
]

for (const name of THEME_NAMES) {
  test(`${name}: 语义色对不等值（truecolor 轨）`, () => {
    const theme = THEMES[name].truecolor
    for (const [a, b] of [...BOTH_TRACK_PAIRS, ...TRUECOLOR_ONLY_PAIRS]) {
      assertPairDistinct(theme, 'truecolor', name, a, b)
    }
  })

  test(`${name}: 语义色对不等值（fallback 16 色轨）`, () => {
    const theme = THEMES[name].fallback
    for (const [a, b] of BOTH_TRACK_PAIRS) {
      assertPairDistinct(theme, 'fallback', name, a, b)
    }
  })
}
