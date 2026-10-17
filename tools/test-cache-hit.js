// 「缓存命中率」口径自测。
//
// 这一层的风险不是算错数，而是**五种来源用了两套说法**：三个来源的 input 不含缓存、
// Codex 的 input 含缓存、WorkBuddy 干脆是两个独立字段。混着写就会有一处把命中率
// 算成未命中率 —— 而且数字看着都「像那么回事」，肉眼发现不了。所以这里逐条钉住。
//
// 纯逻辑，不启动 Electron，几毫秒出结果。
'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const H = require('../shared/cachehit')
const api = require('../providers/api')

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) {
    pass += 1
    console.log('  ✓ ' + name)
  } else {
    fail += 1
    console.log('  ✗ ' + name + (extra === undefined ? '' : '   ← ' + extra))
  }
}
const near = (a, b, eps) => Math.abs(a - b) < (eps === undefined ? 1e-9 : eps)

console.log('缓存命中率 · 口径自测\n')

/* ---------- ① 三种口径 ---------- */

console.log('口径归一：')

// pair —— WorkBuddy：hit / miss 是两个独立字段
let s = H.split({ mode: 'pair', hit: 900, miss: 100 })
ok('pair：hit/miss 原样采纳', s.hit === 900 && s.miss === 100, JSON.stringify(s))
s = H.split({ mode: 'pair', hit: 0, miss: 500 })
ok('pair：一次没命中时命中 0', s.hit === 0 && s.miss === 500)

// aside —— Claude / DSH：input 是未缓存的那部分，缓存读写单列
s = H.split({ mode: 'aside', input: 100, hit: 900, write: 50 })
ok('aside：未命中 = input + write（写缓存也是现算的）', s.miss === 150, JSON.stringify(s))
ok('aside：命中就是 cacheRead', s.hit === 900)

// subset —— Codex / ZCode：input 是总输入，含命中，必须相减
s = H.split({ mode: 'subset', input: 1000, hit: 900 })
ok('subset：未命中 = input - hit', s.miss === 100, JSON.stringify(s))
ok('subset：不会把子集又加一遍（命中率不会 >100%）', H.rate({ mode: 'subset', input: 1000, hit: 900 }).pct === 90)
s = H.split({ mode: 'subset', input: 1000, hit: 900, write: 50 })
ok('subset：写缓存不再加一遍（它本来就在 input 里，加了自己算成 >100%）', s.miss === 100, JSON.stringify(s))

// subset 里 input < hit 是脏数据（日志截断/字段口径变化），不能算出负数
s = H.split({ mode: 'subset', input: 100, hit: 900 })
ok('subset：input < hit 时未命中夹到 0，不出现负数', s.miss === 0 && s.hit === 900, JSON.stringify(s))

// 两家最容易搞混的：DSH 和 ZCode 的字段名一模一样，口径却相反。
// 这里拿实测到的真实一条钉住 —— 混淆了就会把 87.7% 算成 46.7%（或反之）。
const zc = { input: 22685, hit: 19904 }   // ZCode：inputTokens = 2781 + 19904
ok('ZCode 那条真实记录：subset 口径 → 87.7%',
  H.rate({ mode: 'subset', input: zc.input, hit: zc.hit }).pct.toFixed(1) === '87.7',
  H.rate({ mode: 'subset', input: zc.input, hit: zc.hit }).pct.toFixed(1))
ok('同一条若误用 aside 口径 → 46.7%（差了一倍，所以口径不能猜）',
  H.rate({ mode: 'aside', input: zc.input, hit: zc.hit }).pct.toFixed(1) === '46.7',
  H.rate({ mode: 'aside', input: zc.input, hit: zc.hit }).pct.toFixed(1))

/* ---------- ② 命中率与「没数据」 ---------- */

console.log('\n命中率与空值：')

ok('9999 命中 / 1 未命中 → 99.99%', near(H.rate({ mode: 'pair', hit: 9999, miss: 1 }).pct, 99.99, 1e-6))
ok('一次调用都没有 → null（显示 --，而不是骗人的 0%）', H.rate({ mode: 'pair', hit: 0, miss: 0 }) === null)
ok('字段缺失 → null', H.rate({ mode: 'aside' }) === null)
ok('字段是字符串数字也认', H.rate({ mode: 'pair', hit: '900', miss: '100' }).pct === 90)
ok('字段是 NaN / 负数额 → 当 0', H.rate({ mode: 'pair', hit: NaN, miss: -5 }) === null)
ok('undefined 入参不炸', H.rate(undefined) === null && H.rate({}) === null)

ok('text() 默认一位小数', H.text({ mode: 'pair', hit: 7, miss: 1 }) === '87.5%', H.text({ mode: 'pair', hit: 7, miss: 1 }))
ok('text() 没数据返回空串（调用方据此收掉整行）', H.text({ mode: 'pair', hit: 0, miss: 0 }) === '')
ok('text() 可指定小数位', H.text({ mode: 'pair', hit: 7, miss: 1 }, 0) === '88%')

/* ---------- ③ 配色：命中率高才是好 ---------- */

console.log('\n配色档位（和高低是反的，容易写错）：')

ok('99% → 不标色', H.tone(99) === '')
ok('80% → 不标色', H.tone(80) === '')
ok('59% → 黄', H.tone(59) === 'warn')
ok('30% → 黄（边界含）', H.tone(30) === 'warn')
ok('29% → 红', H.tone(29) === 'danger')
ok('0% → 红（有调用但一次没命中，值得看）', H.tone(0) === 'danger')
ok('NaN → 不标色', H.tone(NaN) === '')

/* ---------- ④ 悬停明细 ---------- */

console.log('\n悬停明细：')
const lines = H.detail({ mode: 'pair', hit: 900, miss: 100 }, v => String(v) + 't')
ok('明细两行：token 数 + 百分比', lines.length === 2, JSON.stringify(lines))
ok('明细里有命中率', lines[1].indexOf('90.0%') >= 0, lines[1])
ok('没数据时明细为空数组', H.detail({ mode: 'pair', hit: 0, miss: 0 }).length === 0)
ok('空数据提示文案非空', typeof H.EMPTY_HINT === 'string' && H.EMPTY_HINT.length > 0)

/* ---------- ⑤ 五个来源都声明了这个字段 ---------- */

console.log('\n各插件是否都挂上了这个字段：')

const PROVIDERS = [
  ['workbuddy', 'wbcache'],
  ['dsh', 'dshcache'],
  ['codex', 'codexcache'],
  ['claude', 'claudecache'],
  ['zcode', 'zcodecache'],
]

for (const [id, fieldId] of PROVIDERS) {
  const mod = require('../providers/' + id)
  const ids = (mod.meta.fields || []).map(f => f.id)
  ok(id + ' 声明了 ' + fieldId, ids.indexOf(fieldId) >= 0, ids.join(','))
  const f = (mod.meta.fields || []).find(x => x.id === fieldId)
  ok(id + ' 这一项的显示名是「缓存命中」而不是「未命中」', !!f && /命中/.test(f.label) && !/未命中/.test(f.label), f && f.label)
  // 宿主必须把同一份实现交到插件手上，不能各 require 一份
  ok(id + ' 拿到的 api.cacheHit 就是 shared/cachehit', api.cacheHit === H)
}

ok('workbuddy 的字段 id 没改名（改了就等于把用户已勾的字段静默摘掉）',
  require('../providers/workbuddy').meta.fields.some(f => f.id === 'wbcache'))

/* 口径是写死的字面量，换个值不会有任何报错、只会把数字算错一倍 —— 所以钉一下。
 * 两家的字段名一模一样（都叫 cacheReadTokens）而口径相反，最容易被"顺手统一"。 */
console.log('\n各来源用的口径（按实测结论钉住，别顺手改）：')
const MODES = [
  ['workbuddy', 'pair', 'hit/miss 是两个独立字段'],
  ['dsh', 'aside', 'inputTokens 按 input 价计费 → 是未缓存那部分'],
  ['claude', 'aside', 'Anthropic 的 input_tokens 不含 cache_read'],
  ['codex', 'subset', 'cached_input_tokens 是 input_tokens 的子集'],
  ['zcode', 'subset', 'inputTokens = anthropic.input + cache_read + cache_creation'],
]
for (const [id, mode, why] of MODES) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'providers', id + '.js'), 'utf8')
  const used = (src.match(/mode:\s*'([a-z]+)'/g) || []).map(x => x.replace(/.*'([a-z]+)'.*/, '$1'))
  const set = [...new Set(used)]
  ok(id + ' 用 ' + mode + '（' + why + '）', set.length === 1 && set[0] === mode, '实际用了 ' + set.join(',') || '没找到')
}

/* ---------- ⑥ 面板得真的把这个模块引进去 ---------- */

console.log('\n面板集成：')
const html = fs.readFileSync(path.join(__dirname, '..', 'panel', 'index.html'), 'utf8')
const atHit = html.indexOf('shared/cachehit.js')
const atPanel = html.indexOf('panel.js')
ok('index.html 引了 shared/cachehit.js', atHit >= 0)
ok('它排在 panel.js 之前（否则 panel.js 跑的时候 window.CacheHit 还是 undefined）',
  atHit >= 0 && atPanel >= 0 && atHit < atPanel)

const panelSrc = fs.readFileSync(path.join(__dirname, '..', 'panel', 'panel.js'), 'utf8')
ok('面板不再自己写一遍 (h / (h + m))', panelSrc.indexOf('(h / (h + m))') < 0)
ok('面板用的是 window.CacheHit', panelSrc.indexOf('window.CacheHit') >= 0)

console.log('\n' + (fail === 0 ? '全部 ' + pass + ' 项通过' : pass + ' 项通过，' + fail + ' 项失败'))
process.exit(fail === 0 ? 0 : 1)
