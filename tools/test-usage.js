// 在纯 Node 下验证 usage.js 的采集结果（不依赖 Electron）。
// 用法：node tools/test-usage.js [轮数] [间隔秒]
'use strict'

const usage = require('../usage.js')

const rounds = Number(process.argv[2]) || 3
const gapSec = Number(process.argv[3]) || 4

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

let eventTotal = 0
for (let i = 1; i <= rounds; i++) {
  const t0 = Date.now()
  const { snapshot, events } = usage.poll()
  eventTotal += events.length

  console.log('===== 第 %d 轮 (耗时 %dms) =====', i, Date.now() - t0)
  console.log('  峰谷     :', snapshot.peak.label, snapshot.peak.isPeak ? '(高峰)' : '(谷时)')
  // 注意：Node 的 console.log 只认 %s %d %i %f %j %o %O %c，**不认 %.1f**——
  // 写成 %.1f 会被原样打出来，看起来像「数字没渲染」。百分号自己算好。
  const pct = (snapshot.workbuddy.ctxTokens / snapshot.ctxLimit * 100).toFixed(1) + '%'
  console.log('  上下文   : %s / %s  (%s)',
    snapshot.workbuddy.ctxTokens.toLocaleString(),
    snapshot.ctxLimit.toLocaleString(),
    pct)
  console.log('  WorkBuddy: 可用=%s  今日消耗=%s  调用=%d  活跃=%s',
    snapshot.workbuddy.available,
    snapshot.workbuddy.todayCredit.toFixed(4),
    snapshot.workbuddy.callsToday,
    snapshot.workbuddy.active)
  console.log('  DSH      : 可用=%s  今日消费=¥%s  调用=%d  模型=%s',
    snapshot.dsh.available,
    snapshot.dsh.todayCost.toFixed(4),
    snapshot.dsh.callsToday,
    snapshot.dsh.lastModel || '-')
  if (events.length) {
    for (const e of events) {
      console.log('  ⚡ 扣费事件 [%s] %s %s', e.source, e.amount, e.unit)
    }
  }
  if (i < rounds) sleepSync(gapSec * 1000)
}

console.log('\n本轮共捕获扣费事件: %d 条', eventTotal)
