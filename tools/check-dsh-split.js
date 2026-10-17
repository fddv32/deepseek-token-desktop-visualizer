/* eslint-disable no-console */
/**
 * 检查「按费用构成拆分」对不对：
 *   ① 四项分项之和 == 整笔 cost（不能凭空多钱或少钱）
 *   ② 拆分后的档位/标签符合 dsh-damage-pulse 的口径（未命中=critical / 命中=normal / 输出=weak）
 *   ③ 一笔账会产出几条事件（用户要的「特效变多」）
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const usage = require('../usage')

const LEDGER = path.join(os.homedir(), '.dsh', 'data', 'dsh-token-monitor', 'usage.jsonl')
const lines = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean)

let checked = 0
let mismatch = 0
let partsHist = {}
let sample = null
const EPS = 1e-9

for (const line of lines.slice(-400)) {
  let rec
  try { rec = JSON.parse(line) } catch { continue }
  const cost = Number(rec.cost) || 0
  const parts = ['costInput', 'costCacheRead', 'costOutput', 'costCacheWrite']
    .map(k => Number(rec[k]) || 0)
    .filter(v => v > 0)
  if (cost <= 0) continue
  checked++
  const sum = parts.reduce((a, b) => a + b, 0)
  if (Math.abs(sum - cost) > Math.max(1e-6, cost * 1e-6)) {
    mismatch++
    if (mismatch <= 3) console.log('  差异：cost=' + cost + ' 分项和=' + sum.toFixed(8) + ' ' + JSON.stringify(rec).slice(0, 200))
  }
  const n = parts.length || 1
  partsHist[n] = (partsHist[n] || 0) + 1
  if (!sample && parts.length >= 3) {
    sample = {
      cost, input: rec.costInput, cacheRead: rec.costCacheRead, output: rec.costOutput,
      cacheWrite: rec.costCacheWrite, model: rec.model,
      tokens: { i: rec.inputTokens, o: rec.outputTokens, cr: rec.cacheReadTokens, cw: rec.cacheWriteTokens },
    }
  }
}

console.log('① 分项和 == 整笔 cost：')
console.log('   检查 ' + checked + ' 笔，不一致 ' + mismatch + ' 笔')
console.log('② 一笔账拆成几条（历史分布）：')
for (const k of Object.keys(partsHist).sort()) console.log('   ' + k + ' 条：' + partsHist[k] + ' 笔')
console.log('③ 拆一条样本看看：')
console.log('   ' + JSON.stringify(sample, null, 2).replace(/\n/g, '\n   '))
console.log('④ decorateEvents 排版（含 labe 后缀）：')
console.log('   ' + JSON.stringify(usage.decorateEvents([
  { amount: 0.004, unit: 'CNY', label: '未命中', level: 'critical' },
  { amount: 0.0002, unit: 'CNY', label: '命中', level: 'normal' },
  { amount: 0.0012, unit: 'CNY', label: '输出', level: 'weak' },
])))
console.log('⑤ 连击（速率）：窗口 ' + usage.COMBO_WINDOW_MS + 'ms')
console.log('   第一击 combo=' + usage.markCombo(1000, 'critical') +
  ' 第二击(隔 400ms) combo=' + usage.markCombo(1400, 'critical') +
  ' 第三击(隔 2000ms) combo=' + usage.markCombo(3400, 'critical') +
  ' 轻击 combo=' + usage.markCombo(3500, 'weak'))
