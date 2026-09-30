// 「-多少」飘字的出场节拍器。
//
// 为什么单独抽成一个文件：这一层只有「什么时候该出下一笔」这一件事，不碰 DOM、
// 只认时间，所以能用假时钟确定性地测出来（见 tools/test-hit-pacing.js）。
//
// 它存在的理由是一个真踩过的 bug：
//   一次日志落盘带回来的十几笔扣费是**同一瞬间**到的（一条 IPC 一个任务）。
//   如果只在「队列里还剩东西」的时候才排下一次，那么每一笔到场时队列都是空的，
//   于是每一笔都被立刻放出去 —— 排队完全失效，十几行数字糊在同一帧上，
//   看着是一团红字，什么都读不出来。
//   所以节拍必须挂在**上一次出场的时间**上，而不是挂在队列长度上。
//
// 同时又不能矫枉过正：真的空转（距上次出场已经超过一个间隔）时要 0 延迟立刻出，
// 否则单独来一笔还要白等 170ms 才飘出来，那才叫别扭。
//
// 这个文件两种加载方式都支持：浏览器里是 <script>（挂到 window.HitPacing），
// Node 里 require() 直接拿到同一份对象 —— 测试测的就是线上跑的那份代码。
'use strict'

;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  if (root) root.HitPacing = api
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : null), function () {
  /**
   * 造一个节拍器。它自己**不存**待办队列，只问 `hasPending()` 还算不算数、
   * 到点了就调 `onEmit()` —— 队列归调用方管，这里只管节拍。
   *
   * @param {object} opt
   *   gap       每两笔之间的最小间隔（ms）
   *   now()     当前时间（无参，返回 ms）
   *   setTimer(fn, ms) / clearTimer(id)
   *   hasPending()  还有没有等待出场的东西
   *   onEmit()      该出一笔了；调用后调用方要保证队列少一个
   * @returns {{arm: Function, wait: Function, reset: Function}}
   *   arm()   —— 有新的等着出场时调；没有待办 / 已经排好了就什么都不做（幂等）
   *   wait()  —— 距允许下一笔出场还差多久（0 = 现在就可以）
   *   reset() —— 撤销已排的定时器、清掉节拍记忆（换一批数据重新计时时用）
   */
  function createPacer(opt) {
    const gap = Math.max(0, Number(opt.gap) || 0)
    const now = opt.now
    const setTimer = opt.setTimer
    const clearTimer = opt.clearTimer
    const hasPending = opt.hasPending
    const onEmit = opt.onEmit

    let armed = null
    // -Infinity：从没出过场，第一笔永远 0 延迟。
    // （用 0 不行 —— now() 若是 performance.now() 可能就是个很小的数。）
    let lastAt = -Infinity

    function wait() {
      const w = gap - (now() - lastAt)
      return w > 0 ? w : 0
    }

    function fire() {
      armed = null
      if (!hasPending()) return
      lastAt = now()
      onEmit()
      arm()
    }

    function arm() {
      // 已经排好就别重排：一次 flush 回来几十笔时会连着调几十次 arm()，
      // 每次都重设定时器等于节拍永远等不到头（每来一笔就往后推一次）。
      if (armed || !hasPending()) return
      const w = wait()
      if (w <= 0) fire()
      else armed = setTimer(fire, w)
    }

    return {
      arm,
      wait,
      reset() {
        if (armed !== null) clearTimer(armed)
        armed = null
        lastAt = -Infinity
      },
    }
  }

  return { createPacer }
})
