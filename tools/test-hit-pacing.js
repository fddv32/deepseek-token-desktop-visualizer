// 飘字节拍的纯逻辑自测（不启动 Electron）
//
//   node tools/test-hit-pacing.js
//
// 测的是 shared/hitpacing.js —— **线上跑的就是这一份**（渲染端 <script> 引入，
// 这里 require 引入），所以这里过了就等于桌面上那一串数字真是按这个节拍飘的。
//
// 核心那条用例是「一次 8 笔，同一瞬间到」：出场时刻必须正好是 0/170/340/510/680/850/1020/1190，
// 而不是「全在 0」。后者就是那个真踩过的 bug —— 节拍若挂在队列长度上，
// 每笔到场时队列都是空的，于是每笔都立刻出，十来行数字糊在同一帧上。
'use strict'

let pass = 0
let fail = 0

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  -> ' + extra : '')) }
}

function eq(name, got, want) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  ok(name + '  = ' + w, g === w, '实际 ' + g)
}

/** 假时钟 + 可控定时器：把「等 170ms」变成一次 tick(170)，结果完全确定。 */
function makeClock() {
  let t = 1000 // 故意不从 0 开始：验证「从没出过场」不是靠 now()===0 碰巧成立的
  let seq = 0
  const timers = new Map()
  return {
    now: () => t,
    setTimer(fn, ms) { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id },
    clearTimer(id) { timers.delete(id) },
    /** 时间前进 ms，顺路把到点的定时器全部触发（到点顺序 = 到期时间顺序）。 */
    tick(ms) {
      const to = t + ms
      for (;;) {
        let next = null
        for (const [id, tm] of timers) if (tm.at <= to && (!next || tm.at < next[1].at)) next = [id, tm]
        if (!next) break
        const [id, tm] = next
        timers.delete(id)
        t = tm.at
        tm.fn()
      }
      t = to
    },
    pending: () => timers.size,
  }
}

const HitPacing = require('../shared/hitpacing.js')

try {
  console.log('\n一、导出与基本形状')
  ok('导出 createPacer', typeof HitPacing.createPacer === 'function')
  {
    const c = makeClock()
    const p = HitPacing.createPacer({
      gap: 170, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer,
      hasPending: () => true, onEmit: () => {},
    })
    ok('返回 arm / wait / reset', typeof p.arm === 'function' && typeof p.wait === 'function' && typeof p.reset === 'function')
    ok('从没出过场时 wait() = 0（第一笔不白等）', p.wait() === 0, String(p.wait()))
  }

  console.log('\n二、空转会立刻出，且是**同步**出（不隔一个 tick）')
  {
    const c = makeClock()
    const emitted = []
    let pending = 0
    const p = HitPacing.createPacer({
      gap: 170, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer,
      hasPending: () => pending > 0, onEmit: () => { emitted.push(c.now()); pending -= 1 },
    })
    pending = 1
    p.arm()
    eq('单独一笔在 arm() 那一刻就出了（不等 170ms）', emitted, [1000])
    eq('没有多余的定时器挂着', c.pending(), 0)
  }

  console.log('\n三、一次 8 笔同时到（真 bug 的复现点）')
  {
    const c = makeClock()
    const emitted = []
    let pending = 0
    const p = HitPacing.createPacer({
      gap: 170, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer,
      hasPending: () => pending > 0, onEmit: () => { emitted.push(c.now()); pending -= 1 },
    })
    // 模拟「一条 IPC 一个任务」：8 笔先后 push，但时钟**一格都不走**。
    for (let i = 0; i < 8; i++) { pending += 1; p.arm() }
    eq('同一瞬间 8 笔，只有第 1 笔立刻出', emitted, [1000])
    ok('第 2 笔要等（排上了定时器）', c.pending() === 1, '挂着的定时器 ' + c.pending())

    c.tick(169); eq('+169ms 时还只有 1 笔（差 1ms 也不放行）', emitted.length, 1)
    c.tick(1);   eq('+170ms 时第 2 笔出场', emitted, [1000, 1170])
    c.tick(170 * 6)
    eq('8 笔的出場时刻正好是 0/170/…/1190', emitted,
      [1000, 1170, 1340, 1510, 1680, 1850, 2020, 2190])
    ok('全部出完后不再挂定时器', c.pending() === 0, '挂着的定时器 ' + c.pending())
  }

  console.log('\n四、一笔一笔连着来（债主慢慢上门）')
  {
    const c = makeClock()
    const emitted = []
    let pending = 0
    const p = HitPacing.createPacer({
      gap: 170, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer,
      hasPending: () => pending > 0, onEmit: () => { emitted.push(c.now()); pending -= 1 },
    })
    pending = 1; p.arm()          // t=1000 出
    c.tick(500)                    // 距上次 500ms > 170：空转，应当立刻出
    pending = 1; p.arm()
    eq('隔了 500ms 再来一笔 -> 立刻出（不白等）', emitted, [1000, 1500])

    c.tick(50)                     // 距上次 50ms < 170：要等
    pending = 1; p.arm()
    eq('隔了 50ms 再来一笔 -> 不立刻出', emitted.length, 2)
    c.tick(120)
    eq('补足 170ms 后出场（1500+170=1670）', emitted, [1000, 1500, 1670])
  }

  console.log('\n五、arm() 幂等：一次 flush 几十笔不会把节拍越推越远')
  {
    const c = makeClock()
    const emitted = []
    let pending = 0
    const p = HitPacing.createPacer({
      gap: 170, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer,
      hasPending: () => pending > 0, onEmit: () => { emitted.push(c.now()); pending -= 1 },
    })
    pending = 3; p.arm()
    // 第 2 笔排期在 1170。这两秒里连续再来 30 笔、每次都想 arm() ——
    // 若每次都重设定时器，出场时间会被一路推到无限远（饿死）。
    c.tick(100)
    for (let i = 0; i < 30; i++) { pending += 1; p.arm() }
    ok('重排没有发生：定时器仍是 1 个', c.pending() === 1, '挂着的定时器 ' + c.pending())
    c.tick(70)
    ok('第 2 笔仍按原定的 1170 出场（末次出场 1000 + 170）', emitted[1] === 1170, '实际 ' + emitted[1])
    eq('出场时刻没有被后来的 arm() 推后', emitted.slice(0, 2), [1000, 1170])
  }

  console.log('\n六、队列被抽干 / 被清空后不留残骸')
  {
    const c = makeClock()
    let pending = 2
    let n = 0
    const p = HitPacing.createPacer({
      gap: 170, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer,
      hasPending: () => pending > 0, onEmit: () => { n += 1; pending -= 1 },
    })
    pending = 2; p.arm()
    eq('出了第 1 笔', n, 1)
    // 第 2 笔到点前队列被外部清空（比如窗口重载）：定时器到点后不该凭空造一笔
    pending = 0
    c.tick(200)
    eq('队列空了之后定时器到点也不出（不该凭空出）', n, 1)
    ok('也没留下挂着的定时器', c.pending() === 0)

    // reset()：撤销排期、忘掉节拍，下一笔重新算作「空转」
    pending = 5; p.arm()
    c.tick(50)
    const before = n
    p.reset()
    ok('reset() 撤掉了排期', c.pending() === 0, '挂着的定时器 ' + c.pending())
    ok('reset() 之后 wait() 又回到 0', p.wait() === 0, String(p.wait()))
    pending = 1; p.arm()
    eq('reset() 之后第一笔立刻出（不多不少就一笔）', n, before + 1)
  }

  console.log('\n七、gap = 0 时不卡死（设置成「完全不排队」也得能用）')
  {
    const c = makeClock()
    const emitted = []
    let pending = 0
    const p = HitPacing.createPacer({
      gap: 0, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer,
      hasPending: () => pending > 0, onEmit: () => { emitted.push(c.now()); pending -= 1 },
    })
    for (let i = 0; i < 4; i++) { pending += 1; p.arm() }
    eq('gap=0 时四笔都在同一时刻出', emitted, [1000, 1000, 1000, 1000])
    ok('没有留下定时器', c.pending() === 0)
  }
} catch (err) {
  fail++
  console.log('  ✗ 抛异常：' + ((err && err.stack) || err))
}

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exit(fail === 0 ? 0 : 1)
