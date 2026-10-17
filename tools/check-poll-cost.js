/* 量一下 usage.poll() 一轮要多久：首轮要读全文，之后应该都是增量 tail。
 * 决定「扣费实时」能把周期压到多小 —— 每轮如果只有几毫秒，1s 一轮完全没问题。 */
'use strict'
const usage = require('../usage')

const runs = []
for (let i = 0; i < 12; i++) {
  const t0 = process.hrtime.bigint()
  const r = usage.poll(Date.now() + i)
  const t1 = process.hrtime.bigint()
  runs.push({ ms: Number(t1 - t0) / 1e6, events: r.events.length })
}
const first = runs[0]
const rest = runs.slice(1)
const avg = rest.reduce((a, b) => a + b.ms, 0) / rest.length
const max = Math.max(...rest.map(r => r.ms))
console.log('首轮（要读当天全文）: ' + first.ms.toFixed(1) + ' ms')
console.log('后续 11 轮（增量 tail）: 平均 ' + avg.toFixed(2) + ' ms ｜ 最慢 ' + max.toFixed(2) + ' ms')
console.log('逐轮: ' + runs.map(r => r.ms.toFixed(1)).join(' / ') + ' ms')
console.log('')
console.log('若按 1s 一轮：CPU 占用 ≈ ' + (avg / 1000 * 100).toFixed(2) + '%（单核）')
console.log('现在 2500ms 一轮：≈ ' + (avg / 2500 * 100).toFixed(2) + '%')
console.log('')
console.log('已装载插件: ' + usage.poll().snapshot.plugins.loaded.join(', '))
