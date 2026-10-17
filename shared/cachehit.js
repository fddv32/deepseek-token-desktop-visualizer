// 「缓存命中率」的口径归一。
//
// 为什么要有这个文件：五个来源的账本字段是**三套不同的口径**，直接各写各的
// 算一遍，迟早会有一处把「命中率」算成「未命中率」，而且没人看得出来。
//
//   口径          例子                         input 的含义
//   ---------------------------------------------------------------
//   pair          WorkBuddy                   不适用，hit/miss 是两个独立字段
//   aside         Claude / DSH                 input 是**未缓存**的那部分，缓存读写单列
//   subset        Codex / ZCode                input 是**总输入**（含命中），必须相减
//
// 统一口径：命中率 = 命中 / (命中 + 未命中)，也就是「这次提示词有多少是白捡的」。
// 未命中 = 这次现算的输入，包含「未缓存的输入」和「写缓存」两部分。
//
// 一处容易搞错的地方：Codex 的 `cached_input_tokens` 是 `input_tokens` 的**子集**
// （OpenAI 口径），不能再加一遍 —— 那会把命中率算到 100% 以上。所以单独一个 mode。
//
// 另一个更容易搞错的地方：**ZCode 也是 subset**。它把 Anthropic 的
// `input_tokens` 和 `cache_read_input_tokens` 合并成了一个 inputTokens
// （实测 128/128 条：inputTokens == anthropic.input_tokens + cache_read + cache_creation）。
// 只看字段名（`cacheReadTokens` 和 DSH 同名）会误判成 aside —— DSH 的 inputTokens
// 是**未缓存**那部分（拿 costInput / costCache 对得上），ZCode 的是**总输入**。
// 所以这两家名字一样、口径相反，只能各按各的实测结论来。
//
// 这个文件两种加载方式都支持：浏览器里是 <script>（挂到 window.CacheHit），
// Node 里 require() 直接拿到同一份对象 —— 面板和插件跑的是同一份代码。
'use strict'

;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  if (root) root.CacheHit = api
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : null), function () {
  /** 命中率低于它就标红：这时候基本等于缓存没起作用，花的是全额输入价。 */
  const DANGER_PCT = 30
  /** 低于它标黄：能省一点，但明显没吃到前缀缓存。 */
  const WARN_PCT = 60

  const n = v => {
    const x = Number(v)
    return Number.isFinite(x) && x > 0 ? x : 0
  }

  /**
   * 把各来源口径不一的字段归一到 (命中, 未命中) 这一对。
   *
   * @param {object} opt
   *   mode   'pair' | 'aside' | 'subset'（见文件头）
   *   input  未缓存输入（aside）或总输入（subset）
   *   hit    命中 token
   *   miss   未命中 token（**仅 pair** 用；其余两个由 input/write 推出）
   *   write  写缓存 token，只在 aside 里加：那种口径下它不在 input 里。
   *          subset 下写缓存本来就在 input 里，再加一遍会重复计数 —— 所以忽略。
   * @returns {{hit:number, miss:number}}
   */
  function split(opt) {
    const o = opt || {}
    const hit = n(o.hit)
    if (o.mode === 'pair') return { hit, miss: n(o.miss) }
    if (o.mode === 'subset') return { hit, miss: Math.max(0, n(o.input) - hit) }
    return { hit, miss: n(o.input) + n(o.write) }
  }

  /**
   * 算命中率。
   * @returns {{hit:number, miss:number, total:number, pct:number}|null}
   *   一次调用都没有（total 为 0）时返回 null —— 调用方据此显示 `--`，
   *   而不是显示一个「0%」骗人：0% 和「今天没调用」是两回事。
   */
  function rate(opt) {
    const { hit, miss } = split(opt)
    const total = hit + miss
    if (total <= 0) return null
    return { hit, miss, total, pct: hit / total * 100 }
  }

  /** 显示串：`87.5%`；没数据返回空串。 */
  function text(opt, digits) {
    const r = rate(opt)
    return r ? r.pct.toFixed(digits === undefined ? 1 : digits) + '%' : ''
  }

  /** 配色档位。命中率**越高越好**，所以和「未命中率」的高低是反的。 */
  function tone(pct) {
    if (!Number.isFinite(pct)) return ''
    if (pct < DANGER_PCT) return 'danger'
    if (pct < WARN_PCT) return 'warn'
    return ''
  }

  /** 四种调用（一次都不写盘的那种）时的说明文案，各处复用免得各写一句。 */
  const EMPTY_HINT = '今天还没读到带缓存字段的调用记录'

  /**
   * 悬停明细的公共几行：命中多少、未命中多少、这次是白捡的还是现算的。
   * `fmtTokens` 由调用方传（宿主的格式化函数，插件里是 ctx.fmtTokens）。
   */
  function detail(opt, fmtTokens) {
    const r = rate(opt)
    if (!r) return []
    const f = typeof fmtTokens === 'function' ? fmtTokens : v => String(v)
    return [
      '命中 ' + f(r.hit) + ' token · 未命中 ' + f(r.miss) + ' token',
      '命中率 ' + r.pct.toFixed(1) + '%（越高越省：命中的那部分按缓存价计费）',
    ]
  }

  return { split, rate, text, tone, detail, EMPTY_HINT, DANGER_PCT, WARN_PCT }
})
