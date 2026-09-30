// 诊断：WorkBuddy 日志目录里到底有哪些文件，usage.js 的正则各能匹配多少。
'use strict'
const fs = require('fs')
const path = require('path')
const os = require('os')

const ROOT = path.join(os.homedir(), '.workbuddy', 'logs')

console.log('=== 日志根目录 ===')
for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
  const full = path.join(ROOT, e.name)
  const st = fs.statSync(full)
  console.log('  %s %-46s %s',
    e.isDirectory() ? '[目录]' : '[文件]',
    e.name,
    e.isDirectory() ? '' : st.size + ' bytes  ' + st.mtime.toISOString())
}

const RE_CTX = /^\[\d{4}\/\d{1,2}\/\d{1,2} [\d:.]+\] \[[^\]]+\] \[pid=\d+\] \[shouldCompact\] Added trailing tool result tokens: \+\d+, totalTokens=(\d+), isSubAgent=(true|false)/
const RE_CREDIT = /^\[\d{4}\/\d{1,2}\/\d{1,2} [\d:.]+\] \[[^\]]+\] \[pid=\d+\] \[SessionManager\]\[credit\] Credit received: rootRequestId=([0-9a-f]+), source=([A-Za-z_]+), credit=([\d.]+)/

const days = fs.readdirSync(ROOT, { withFileTypes: true })
  .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
  .map(e => e.name).sort().slice(-2)

console.log('\n=== 最近两天的目录内所有文件 ===')
for (const day of days) {
  const dir = path.join(ROOT, day)
  console.log('--- ' + day)
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    const st = fs.statSync(full)
    let ctx = 0, credit = 0, stream = 0
    let lastCtx = 0
    if (e.isFile()) {
      const text = fs.readFileSync(full, 'utf8')
      for (const line of text.split('\n')) {
        let m = RE_CTX.exec(line)
        if (m) { ctx++; if (m[2] === 'false') lastCtx = Number(m[1]); continue }
        m = RE_CREDIT.exec(line)
        if (m) { credit++; if (m[2] === 'raw_model_stream_event') stream++ }
      }
    }
    console.log('  %-60s %9d B  mtime=%s', e.name, st.size, st.mtime.toISOString())
    console.log('      正则匹配: shouldCompact=%d (最后 totalTokens=%d)  credit=%d (其中 stream=%d)',
      ctx, lastCtx, credit, stream)
  }
}
