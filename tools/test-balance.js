// 单独验证余额查询这条链路（异步，需要等一会儿）。
'use strict'
const usage = require('../usage.js')

usage.poll()
console.log('已触发首轮采集，等待余额接口返回...')

setTimeout(() => {
  const snap = usage.poll().snapshot
  console.log('balance =', JSON.stringify(snap.dsh.balance, null, 2))
  console.log('dsh 今日消费 =', snap.dsh.todayCost, ' 调用 =', snap.dsh.callsToday)
  console.log('wb 今日消耗 =', snap.workbuddy.todayCredit, ' 调用 =', snap.workbuddy.callsToday)
}, 7000)
