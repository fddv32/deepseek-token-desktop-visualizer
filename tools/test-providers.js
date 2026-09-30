// 抽查各用量插件：能不能装载、能不能读出数据。
//
// 带「时间旅行」：把 Date.now 拨到某一天再装载，这样能验证解析逻辑本身是对的，
// 而不是只能看「今天恰好有没有用量」。
// 注意 Node 的 console.log 只认 %s %d %i %f %j %o %O %c，
// **不认 %-12s 这种宽度修饰**，写了会原样打出来。对齐自己用 padEnd 做。
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

// 这个脚本是**只读**的，不会改任何东西，所以不用加锁。但如果另一个测试
// （test-user-plugin.js）正在临时改写账本，这里的「手动记账 / 今日已用」就会是
// 它塞进去的测试数据。提醒一句，免得对着假数字排查半天。
const LEDGER_LOCK = path.join(os.homedir(), '.whalepet', '.ledger-test.lock')
if (fs.existsSync(LEDGER_LOCK)) {
  console.log('!! 注意：' + LEDGER_LOCK + ' 存在，可能有另一个测试正在改写账本，')
  console.log('   下面的「手动记账」和「今日已用」数字不可信。\n')
}

const TARGET = process.env.WHALEPET_TEST_DAY || ''   // 形如 2026-09-29
let realNow = Date.now
if (TARGET) {
  const t = Date.parse(TARGET + 'T12:00:00+08:00')
  if (Number.isFinite(t)) {
    Date.now = () => t
    console.log('（时间旅行到 ' + TARGET + ' 12:00 北京时间）\n')
  }
}

const usage = require('../usage')
const { snapshot, events } = usage.poll(Date.now())

const pad = (s, n) => String(s).padEnd(n)
const fmtField = f => {
  const v = (f.label ? f.label + '=' : '') + f.value + (f.unit ? ' ' + f.unit : '')
  return f.tone ? v + '(' + f.tone + ')' : v
}

console.log('已装载插件 :', snapshot.plugins.loaded.join(', '))
console.log('信息条字段 :', snapshot.fields.map(fmtField).join('  |  '))
console.log('')
console.log('各来源明细：')
for (const [id, d] of Object.entries(snapshot.providers)) {
  console.log('  ' + pad(id, 9) + JSON.stringify(d))
}
console.log('')

const list = usage.listProviders()
console.log('插件清单：')
for (const p of list.providers) {
  console.log('  [' + (p.builtin ? '内置' : '用户') + '] ' + pad(p.id, 10) + pad(p.vendor, 26)
    + ' 安装=' + pad(p.installed, 6) + ' 可用=' + pad(p.available, 6) + (p.detail || ''))
}
if (list.errors.length) {
  console.log('加载错误：')
  for (const e of list.errors) console.log('  ' + e.file + ' -> ' + e.message)
}
console.log('')
console.log('可选字段   :', usage.fieldCatalog().map(f => f.id + '(' + f.label + ')').join(', '))
console.log('本次事件数 :', events.length)
