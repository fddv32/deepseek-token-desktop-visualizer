// 尺寸几何的纯逻辑自测（不启动 Electron）
//
//   node tools/test-scale.js
//
// 测的是 shared/petsize.js —— 线上跑的就是这一份（main.js require 它）。
//
// 要守住的是一条很容易悄悄破坏的规矩：**每一个能选到的尺寸，形象都得真的跟着变大。**
// 形象是只缩不放的（pet.css 的 max-height / max-width 做 contain），所以一旦某一档
// 让窗口长过了形象的原始像素，那一档就退化成「只有窗口和信息条在长，鱼原地不动」——
// 桌面上看就是「一个大宽框里放着鱼」，也就是用户说的「大形象显得太宽」。
// 上一版的「大 = 140%」正是这样：窗口 532px，鱼只有 372px。
//
// 所以这里的断言不能只看「数字有没有变大」，得按 contain + 只缩不放 的规则算出
// 形象**最终画出来多大**再比。
'use strict'

const fs = require('fs')
const path = require('path')

const P = require('../shared/petsize')

const ROOT = path.dirname(__dirname)
const SETTINGS = path.join(ROOT, 'settings', 'index.html')
const ASSET = path.join(ROOT, 'assets', 'shayu')

let pass = 0
let fail = 0

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  -> ' + extra : '')) }
}

function eq(name, got, want) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  ok(name + '  = ' + w, g === w, '实际 ' + g)
}

/** 只读 PNG 头里那 8 个字节，别为了量个尺寸把 1MB 的帧全读进来。 */
function pngSize(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(26)
    const n = fs.readSync(fd, buf, 0, 26, 0)
    if (n < 26 || buf.slice(1, 4).toString('latin1') !== 'PNG') return null
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
  } finally {
    fs.closeSync(fd)
  }
}

function walk(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.isFile() && e.name.toLowerCase().endsWith('.png')) out.push(p)
  }
  return out
}

/**
 * 形象最终被画成多大 —— 复刻 renderer/pet.css 那条 contain：
 * 同时受窗口宽和形象区高约束，且**永远不会超过自己的原始像素**（只缩不放）。
 *
 * 两个数都要留着：
 *   raw —— 窗口希望把形象画成它的多少倍。**超过 1 就说明窗口在长、形象画不动了**
 *          （照片已经顶到原始像素），也就是「一个大宽框里放着鱼」那种样子。
 *   k   —— 实际画出来的倍数（raw 被 1 截断）。用户看到的是这个。
 */
function rendered(scale, barH) {
  const { w } = P.baseSize(scale, barH)
  const area = P.petAreaH(scale, barH)
  const raw = Math.min(w / P.CANVAS_W, area / P.CANVAS_H)
  const k = Math.min(1, raw)
  return { raw, k, w: P.CANVAS_W * k, h: P.CANVAS_H * k, win: w, area }
}

/** 界面上真正提供的那几档，直接从 HTML 里取 —— 免得这里和界面各写一份数字。 */
function uiScales() {
  const html = fs.readFileSync(SETTINGS, 'utf8')
  const seg = /<div class="seg" id="scale">([\s\S]*?)<\/div>/.exec(html)
  if (!seg) return []
  return Array.from(seg[1].matchAll(/data-scale="([\d.]+)"/g)).map(m => Number(m[1]))
}

// ---------------------------------------------------------------- 素材画布

console.log('— 素材画布 —')
const frames = walk(path.join(ASSET, 'frames'))
const others = [path.join(ASSET, 'idle.png')].concat(walk(path.join(ASSET, 'states')))
ok('扫到帧素材（' + frames.length + ' 张帧 + ' + others.length + ' 张单图）', frames.length > 20)

const sizes = new Map()
for (const f of frames.concat(others)) {
  const s = pngSize(f)
  if (!s) { ok('能读到 ' + path.basename(f) + ' 的 PNG 头', false); continue }
  const key = s.w + 'x' + s.h
  sizes.set(key, (sizes.get(key) || 0) + 1)
}
eq('所有素材画布尺寸一致', Array.from(sizes.keys()), [P.CANVAS_W + 'x' + P.CANVAS_H])
ok('petsize 的 CANVAS 常量与真素材一致（改了素材忘了改常量会在这里红）',
   sizes.has(P.CANVAS_W + 'x' + P.CANVAS_H), Array.from(sizes.keys()).join(', '))

// ---------------------------------------------------------------- 界面档位

console.log('— 界面档位 —')
const scales = uiScales()
eq('界面上是 0.7 / 0.9 / 1.1 三档', scales, [0.7, 0.9, 1.1])
ok('三档递增', scales.every((v, i) => i === 0 || v > scales[i - 1]), scales.join(' / '))
ok('每一档都不超过 MAX_SCALE（' + P.MAX_SCALE + '）',
   scales.every(v => v <= P.MAX_SCALE), scales.join(' / '))
eq('最大那一档就是 MAX_SCALE', Math.max.apply(null, scales), P.MAX_SCALE)

// ---------------------------------------------------------------- 夹取

console.log('— clampScale —')
ok('NaN 交回给调用方兜底', Number.isNaN(P.clampScale('不是数', 78)))
eq('0.05 夹到下限', P.clampScale(0.05, 78), P.MIN_SCALE)
eq('0.93 原样保留', P.clampScale(0.93, 78), 0.93)
eq('老配置里的 1.4 被夹到现在这一档', P.clampScale(1.4, 78), 1.1)
eq('0.666 收成两位', P.clampScale(0.666, 78), 0.67)
// 信息条特别高时，形象区被吃掉，上限跟着降 —— 但不能降过头（floor，不是四舍五入）
const tinyBudget = P.clampScale(1.4, 320)
ok('信息条 320px 时上限跟着降到 ' + tinyBudget, tinyBudget < 1.1 && tinyBudget >= 1.0, String(tinyBudget))

// ---------------------------------------------------------------- 核心不变量

console.log('— 形象必须真的跟着变大 —')
// setBarHeight 把信息条夹在 40~320，这里把整个范围走一遍
let worstRaw = 0
let worstAt = ''
for (let barH = 40; barH <= 320; barH += 4) {
  for (const s of scales) {
    const used = P.clampScale(s, barH)
    const r = rendered(used, barH)
    if (r.raw > worstRaw) { worstRaw = r.raw; worstAt = 'barH=' + barH + ' scale=' + used }
  }
}
ok('任何信息条高度 + 任何档位下，形象都还画不满自己的原始像素'
   + '（画满了 = 只缩不放生效，窗口再大也只是空框）'
   + ' 最高 ' + worstRaw.toFixed(3) + '（' + worstAt + '）', worstRaw <= 1)

// 真实会出现的两种信息条高度：实测一行 52px，主进程预留 78px
const BAR_TYPICAL = [52, 78]
console.log('— 窗口不浪费宽度（信息条 ' + BAR_TYPICAL.join(' / ') + 'px） —')
for (const barH of BAR_TYPICAL) {
  for (const s of scales) {
    const r = rendered(s, barH)
    const share = r.w / r.win
    ok('尺寸 ' + s + ' 信息条 ' + barH + 'px：形象铺满窗口宽 ' + (share * 100).toFixed(1) + '%',
       share >= 0.8 && share <= 1.0, share.toFixed(3))
  }
}

console.log('— 三档要拉得开 —')
for (const barH of BAR_TYPICAL) {
  for (let i = 1; i < scales.length; i++) {
    const a = rendered(scales[i - 1], barH).w
    const b = rendered(scales[i], barH).w
    ok('信息条 ' + barH + 'px：' + scales[i - 1] + ' -> ' + scales[i]
       + ' 形象宽 ' + a.toFixed(0) + ' -> ' + b.toFixed(0) + '（' + (b / a).toFixed(2) + '×）',
       b / a >= 1.2, (b / a).toFixed(3))
  }
}

console.log('')
console.log(pass + ' 项通过，' + fail + ' 项失败')
process.exit(fail ? 1 : 0)
