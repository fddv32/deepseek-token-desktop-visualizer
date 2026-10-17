// 「扣费实时 + 余额 60 秒校准」自测。
//
// 关键点是**两次校准之间余额必须是动的**：每读到一笔 DSH 花费就先把显示值减掉，
// 不然一笔笔扣费飘过去了、信息条上的数字却纹丝不动（要等下一个 60s 才跳一下），
// 看着就像没生效。这里用 WHALEPET_HOME 把插件家目录指到临时目录、塞一份假账本，
// **不碰真实账本**，端到端验证「读到几笔就减几笔、而且只减一次」。
//
// 纯逻辑，不启动 Electron，几十毫秒出结果。
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

// 必须在 require('../usage') 之前设：插件家目录是在装载时读的
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'whalepet-home-'))
process.env.WHALEPET_HOME = HOME
process.env.WHALEPET_NO_BALANCE = '1'   // 不联网，余额那边只验算式
const LEDGER_DIR = path.join(HOME, '.dsh', 'data', 'dsh-token-monitor')
fs.mkdirSync(LEDGER_DIR, { recursive: true })
const LEDGER = path.join(LEDGER_DIR, 'usage.jsonl')

function row(cost, parts, seq) {
  return JSON.stringify({
    timestamp: Date.now(),
    sessionId: 'test-session',
    sourceEventSeq: seq,
    model: 'deepseek-flash',
    cost,
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 2000,
    cacheWriteTokens: 0,
    costInput: parts[0],
    costCacheRead: parts[1],
    costOutput: parts[2],
    costCacheWrite: 0,
  })
}

const usage = require('../usage')

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
const near = (a, b) => Math.abs(a - b) < 1e-9

console.log('扣费实时 · 余额 60 秒校准 · 自测\n')

console.log('周期：')
ok('采集周期 1s（扣费实时）', usage.POLL_MS === 1000, String(usage.POLL_MS))
ok('余额校准 60s', usage.BALANCE_INTERVAL_MS === 60000, String(usage.BALANCE_INTERVAL_MS))
ok('两个周期互相独立（压采集周期不会带着余额一起 1s 一次）',
  usage.POLL_MS !== usage.BALANCE_INTERVAL_MS)

console.log('\n只有 DeepSeek 的人民币花费实时减余额：')
ok('dsh + CNY -> 减', usage.countsTowardBalance(0.02, 'CNY', 'dsh') === true)
ok('workbuddy + credit -> 不减', usage.countsTowardBalance(3, 'credit', 'workbuddy') === false)
ok('claude + token -> 不减', usage.countsTowardBalance(50000, 'token', 'claude') === false)
ok('金额为 0 -> 不减（不产生账面变化）', usage.countsTowardBalance(0, 'CNY', 'dsh') === false)

console.log('\n显示值 = 官方校准值 − 实时扣掉的：')
ok('10 元减掉 0.027 -> 9.973', near(usage.liveBalanceOf(10, 0.027), 9.973))
ok('没校准过显示 null（不是 0）', usage.liveBalanceOf(null, 1) === null)
ok('官方给 0（欠费）时夹到 0，不显示负数', usage.liveBalanceOf(0.01, 0.5) === 0)
ok('扣到正好归零', usage.liveBalanceOf(0.5, 0.5) === 0)

console.log('\n端到端（假账本，WHALEPET_HOME 指到临时目录）：')
// 冷启动场景：**装好之前账本里就已经有账**（近 1 小时的历史）。这批只播种、不播动画。
fs.writeFileSync(LEDGER, row(0.0239, [0.001, 0.0026, 0.0203], 1) + '\n')
let r = usage.poll()
let snap = r.snapshot
ok('首轮读到的历史账一条都不播（冷启动不刷屏）', r.events.length === 0, String(r.events.length))
ok('但账照算：今日笔数 +1', snap.dsh.callsToday === 1, String(snap.dsh.callsToday))
ok('首轮那笔也不算进「实时扣减」（它已含在官方校准值里，算了就是重复扣）',
  near(snap.dsh.balance.spentSince, 0), String(snap.dsh.balance.spentSince))

// 首轮之后新到的一笔：要播，也要实时减余额
fs.appendFileSync(LEDGER, row(0.01, [0.001, 0.001, 0.008], 2) + '\n')
r = usage.poll()
snap = r.snapshot
ok('首轮之后新到的账才播（按费用构成拆成 3 条）', r.events.length === 3, String(r.events.length))
ok('实时扣减 == 整笔 cost（不是三个分项各减一遍）',
  near(snap.dsh.balance.spentSince, 0.01), String(snap.dsh.balance.spentSince))
ok('今日笔数累计到 2', snap.dsh.callsToday === 2, String(snap.dsh.callsToday))

// 第三笔：累加
fs.appendFileSync(LEDGER, row(0.0239, [0.001, 0.0026, 0.0203], 3) + '\n')
snap = usage.poll().snapshot
ok('再来一笔：累加到 0.0339', near(snap.dsh.balance.spentSince, 0.0339), String(snap.dsh.balance.spentSince))

// 不重复计：同一批记录再读一次不该再减
const before = snap.dsh.balance.spentSince
snap = usage.poll().snapshot
ok('同一批记录重复读不会重复扣（去重靠 sessionId+seq）',
  near(snap.dsh.balance.spentSince, before), String(snap.dsh.balance.spentSince))

console.log('\n校准后重新起算：')
ok('快照里 value 是官方值、live 是实时值、spentSince 是自校准以来的累减',
  'value' in snap.dsh.balance && 'live' in snap.dsh.balance && 'spentSince' in snap.dsh.balance)
ok('本测试关了余额接口，所以 value 是 null、live 也是 null（不显示假数字）',
  snap.dsh.balance.value === null && snap.dsh.balance.live === null,
  JSON.stringify({ v: snap.dsh.balance.value, l: snap.dsh.balance.live }))

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch { /* 临时目录删不掉也无所谓 */ }

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exit(fail === 0 ? 0 : 1)
