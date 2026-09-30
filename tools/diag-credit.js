// 逐行验证 credit 的日期归属，定位为什么只统计到 5 条。
'use strict'
const fs = require('fs')
const path = require('path')
const os = require('os')
const usage = require('../usage.js')

const RE_CREDIT = /^\[\d{4}\/\d{1,2}\/\d{1,2} [\d:.]+\] \[[^\]]+\] \[pid=\d+\] \[SessionManager\]\[credit\] Credit received: rootRequestId=([0-9a-f]+), source=([A-Za-z_]+), credit=([\d.]+)/
const RE_LOG_TS = /^\[(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{2}):(\d{2})\.(\d{3})\]/
const BJ = 8 * 3600 * 1000

function parseLogTs(line) {
  const m = RE_LOG_TS.exec(line)
  if (!m) return 0
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]) - BJ
}

const dir = path.join(os.homedir(), '.workbuddy', 'logs', '2026-09-30')
const file = path.join(dir, '2026-09-29-23-59-10__1c70c4c69891097d75be765142419148.log')

const today = usage.bjDayKey(Date.now())
console.log('今天的 dayKey =', today, ' 文件 =', path.basename(file))
console.log('文件大小 =', fs.statSync(file).size)

const text = fs.readFileSync(file, 'utf8')
let total = 0, stream = 0, okDate = 0, tsZero = 0, dup = 0
const byDay = new Map()
const seen = new Set()
const samples = []

for (const line of text.split('\n')) {
  const m = RE_CREDIT.exec(line)
  if (!m) continue
  total++
  if (m[2] !== 'raw_model_stream_event') continue
  stream++
  if (seen.has(m[1])) { dup++; continue }
  seen.add(m[1])

  const at = parseLogTs(line)
  if (!at) tsZero++
  const k = usage.bjDayKey(at || Date.now())
  byDay.set(k, (byDay.get(k) || 0) + 1)
  if (k === today) okDate++
  if (samples.length < 3) samples.push([line.slice(0, 60), at, k])
}

console.log('credit 行总数        =', total)
console.log('其中 stream 事件     =', stream)
console.log('requestId 去重后     =', seen.size, '(重复', dup, ')')
console.log('时间戳解析失败       =', tsZero)
console.log('判定为今天的         =', okDate)
console.log('日期分布             =', [...byDay.entries()])
console.log('样例:')
for (const s of samples) console.log('   ', s[0], '-> ts=', s[1], 'dayKey=', s[2])
