// 核对 WorkBuddy 的 credit 合计：直接扫日志算一遍，再和插件读到的数比一比。
//
// 为什么专门做这个：credit 行是**增量**的 —— 同一个 requestId（一次用户回合）会
// 陆续写几百行，每行是一次模型调用的结算。去重键一旦写错（比如按 requestId 去重），
// 数字会**静默**少算十几倍，而桌面上只是「积分不怎么涨」，看不出是坏的。
// 实测踩过一次：1254 行 / 138.97 积分被算成 13 行 / 9.03。
//
//   node tools\diag-credit.js
//
// 只看今天（北京时间）。要验证别的日期用 test-providers.js 的时间旅行。
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const RE_CREDIT = /^\[(\d{4})\/(\d{1,2})\/(\d{1,2}) [\d:.]+\] \[[^\]]+\] \[pid=\d+\] \[SessionManager\]\[credit\] Credit received: rootRequestId=([0-9a-f]+), source=([A-Za-z_]+), credit=([\d.]+)/
const DAY_MS = 24 * 60 * 60 * 1000
const ROOT = path.join(os.homedir(), '.workbuddy', 'logs')

/**
 * 候选文件。口径必须和 providers/workbuddy.js 的 listLogs() 一模一样
 * （最近两天的日期目录、mtime 在 24 小时内的 *.log）—— 口径不同就没法比。
 */
function listFiles() {
  let days = []
  try {
    days = fs.readdirSync(ROOT, { withFileTypes: true })
      .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
      .map(e => e.name).sort().slice(-2)
  } catch { return [] }
  const cutoff = Date.now() - DAY_MS
  const out = []
  for (const day of days) {
    const dir = path.join(ROOT, day)
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.log')) continue
      const full = path.join(dir, ent.name)
      try { if (fs.statSync(full).mtimeMs < cutoff) continue } catch { continue }
      out.push(full)
    }
  }
  return out
}

const pad2 = n => String(n).padStart(2, '0')

/** 逐行扫一个文件，只认属于 `day` 的 stream 事件。 */
function scan(file, day) {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return { lines: 0, credit: 0, skipped: 0 } }
  let lines = 0
  let credit = 0
  let skipped = 0
  for (const line of text.split('\n')) {
    const m = RE_CREDIT.exec(line)
    if (!m) continue
    // 分组：1=年 2=月 3=日 4=requestId 5=source 6=credit（requestId 这里用不上）
    const [, y, mo, d, , source, rawCredit] = m
    if (y + '-' + pad2(mo) + '-' + pad2(d) !== day) continue
    if (source !== 'raw_model_stream_event') { skipped++; continue } // response_done 那条没有金额
    lines++
    credit += Number(rawCredit) || 0
  }
  return { lines, credit, skipped }
}

const day = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
const files = listFiles()

console.log('北京时间 ' + day + ' · 候选日志 ' + files.length + ' 个')
console.log('')

let sumLines = 0
let sumCredit = 0
for (const f of files) {
  const r = scan(f, day)
  if (!r.lines && !r.skipped) continue
  sumLines += r.lines
  sumCredit += r.credit
  console.log('  ' + path.relative(ROOT, f))
  console.log('      ' + r.lines + ' 行 / ' + r.credit.toFixed(2) + ' 积分'
    + (r.skipped ? '（跳过 ' + r.skipped + ' 行非 stream 事件）' : ''))
}

console.log('')
console.log('日志直算 : ' + sumLines + ' 行 / ' + sumCredit.toFixed(2) + ' 积分')

// 再用插件本身读一遍。两边几乎同时跑，差异只会来自「这中间新落的日志」，所以容差给 1。
const usage = require('../usage')
const { snapshot } = usage.poll(Date.now())
const wb = (snapshot.providers && snapshot.providers.workbuddy) || {}
const pluginCredit = Number(wb.todayCredit) || 0
const pluginLines = Number(wb.callsToday) || 0
const diff = pluginCredit - sumCredit

console.log('插件读数 : ' + pluginLines + ' 行 / ' + pluginCredit.toFixed(2) + ' 积分')
console.log('')
if (Math.abs(diff) <= 1 && Math.abs(pluginLines - sumLines) <= 5) {
  console.log('✓ 一致（插件里的去重与过滤都对）')
} else {
  console.log('!! 对不上，差 ' + diff.toFixed(2) + ' 积分 / ' + (pluginLines - sumLines) + ' 行')
  if (pluginLines > 0 && pluginLines * 5 < sumLines) {
    console.log('   行数少了一个数量级 —— 十有八九是 providers/workbuddy.js 里')
    console.log('   又按 requestId 去重了。credit 是增量的，同一次请求会写很多行，')
    console.log('   必须逐条累加，去重键只能用「行时间戳 + 请求 id + 金额」。')
  }
  process.exitCode = 1
}
