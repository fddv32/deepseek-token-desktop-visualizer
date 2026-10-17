// providers/dsh.js —— DSH（DeepSeek Harness）用量
//
// 数据源：~/.dsh/data/dsh-token-monitor/usage.jsonl（dsh-token-monitor 插件自己的账本）
// 每行一次调用：
//   {timestamp, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost, sessionId, ...}
// cost 是插件按官方峰谷价算好的人民币金额，直接用，不要自己再乘一遍价目表。
//
// **token 口径（踩过坑）**：账本里的 `inputTokens` 只是「**未命中缓存**」的那部分输入，
// 命中的那一大坨在 `cacheReadTokens` 里 —— 实测今天 input 15.9 万、cacheRead 2269 万，
// 也就是说「今日 token」必须 `input + output + cacheRead + cacheWrite` 全加。
// 早先只加了 input + output，于是信息条上的「DSH 今日」和「今日已用」合计都比真实值
// 小 77 倍（30.0万 vs 2300万）。**用户报的「token 显示错误」就是它。**
// 注意别和「缓存命中率」的口径搞混：命中率是 `cacheRead / (cacheRead + input)`，
// 那个口径下 input 仍然只算未命中部分（见下面 todayInput 的注释）。
//
// 为什么不直接读 ~/.dsh/sessions/**/session.v4.jsonl.zstd：
// 那是 zstd 压缩流，Node 20 内置模块没有 zstd 解码器（node:zlib 只到 gzip/br/deflate），
// 为了它引一个原生依赖不值当 —— 而这个账本是等价的明文副本。
'use strict'

const meta = {
  id: 'dsh',
  label: 'DSH',
  vendor: 'DeepSeek Harness',
  badge: 'DSH',
  builtin: true,
  unit: 'token',
  // 面板上按 token 显示（和其余来源一个口径），但**这一笔账是人民币** ——
  // 账本里本来就带着按峰谷价算好的 cost，所以受击和飘字都用元，不折算。
  paths: ['~/.dsh/data/dsh-token-monitor/usage.jsonl'],
  desc: '读 dsh-token-monitor 的明文账本（含按峰谷价算好的 cost）',
  fields: [
    { id: 'dsh', label: 'DSH 今日', unit: 'token', desc: 'DSH 今日的 token 用量（输入+输出+缓存命中，花费见悬停明细）' },
    { id: 'dshcache', label: 'DSH 缓存命中', desc: '今日 DeepSeek 隐式缓存的命中占比，越高越省（命中的部分按缓存价计费）' },
    { id: 'balance', label: 'DeepSeek 余额', desc: '联网查一次官方 /user/balance' },
  ],
  // 受击阈值，单位**人民币** —— 这个插件 emit 的账就是 cost（元），
  // 单位在事件里写明了，编排层原样用，所以「用多少扣多少」飘出来的就是 ¥ 数字。
  // 一次调用约 ¥0.004 上下，0.012 算暴击。
  damage: [[0.012, 'critical'], [0.004, 'normal']],
}

/* 一笔账**按费用构成拆成多条**受击，力度按**费用种类**定 —— 这是照 DSH 里那个
 * dsh-damage-pulse 插件（4.1.3）抄的，它的口径是「缓存感知的扣血」：
 *
 *   未命中缓存 costInput     -> critical  付的是**全价输入**，最疼
 *   命中缓存   costCacheRead -> normal    便宜，但量大
 *   输出       costOutput    -> weak      按 output 价（4 元/M），单价最高但量小
 *   缓存写入   costCacheWrite-> weak
 *
 * 为什么**不按金额分档**：那个插件的 severity 是 `kind === 'output' ? 1 : kind === 'normal' ? 2 : 3`
 * —— 看的是**这笔钱花在哪儿**，不是花了多少。0.002 元的未命中比 0.01 元的输出更该疼，
 * 因为前者是「本该命中缓存却没命中」。这也让「一笔账」在桌面上变成 2~4 条飘字，
 * 而不是一个被加总的数字 —— 桌面上的观感就是「掉血特效变多了」。
 *
 * 金额为 0 的那几项不发（没花钱就不掉血）。四项之和恒等于整笔 cost（实测 400/400 笔
 * 分毫不差，见 tools/check-dsh-split.js），所以拆分不会让账面变多或变少。
 *
 * 注意档位只管**动画**，飘字字号由 usage.js 按金额另算（`big`）—— 否则会出现
 * 「¥0.001 的未命中字比 ¥0.02 的输出还大」。
 */
const COST_PARTS = [
  { kind: 'input', label: '未命中', level: 'critical', field: 'costInput' },
  { kind: 'cache', label: '命中', level: 'normal', field: 'costCacheRead' },
  { kind: 'output', label: '输出', level: 'weak', field: 'costOutput' },
  { kind: 'write', label: '缓存写入', level: 'weak', field: 'costCacheWrite' },
]

/** 把一行账本拆成若干条「费用构成」。拿不到分项就退回整笔（别漏掉这次扣费）。 */
function costParts(rec, num) {
  const parts = []
  for (const p of COST_PARTS) {
    const v = num(rec[p.field])
    if (v > 0) parts.push({ kind: p.kind, label: p.label, level: p.level, cost: v })
  }
  if (parts.length > 0) return parts
  const whole = num(rec.cost)
  return whole > 0 ? [{ kind: 'normal', label: '', level: 'normal', cost: whole }] : []
}

function create(api) {
  const { fs, path, bjDayKey, num } = api
  const LEDGER = api.expand('~/.dsh/data/dsh-token-monitor/usage.jsonl')
  const STATE = api.expand('~/.dsh/data/dsh-token-monitor/state.json')

  const state = {
    tailer: null,
    dayKey: 0,
    todayCost: 0,
    callsToday: 0,
    todayTokens: 0,
    todayInput: 0,     // 未命中缓存的那部分输入（账本里 inputTokens 就是它）
    todayOutput: 0,
    todayCacheRead: 0, // 命中
    todayCacheWrite: 0,
    lastCallAt: 0,
    lastModel: '',
    updatedAt: 0,
    available: false,
    detail: '',
    seen: new Set(),
    // 首轮只「播种」不报账：冷启动会把账本从头读一遍，那批历史不能当新账播
    // （否则启动瞬间几百条飘字，见 poll() 里那段注释）。
    seeded: false,
  }

  function poll(now, emit) {
    if (!fs.existsSync(LEDGER)) {
      state.available = false
      state.detail = '未找到 dsh-token-monitor 账本'
      return
    }
    state.available = true
    if (!state.tailer) {
      // DSH 账本要算「今日消费」，必须从头上读，所以初始 offset=0，
      // 但用 seen 集合 + 时间戳过滤保证不会把旧账算成新事件。
      state.tailer = new api.Tailer(LEDGER)
      state.tailer.offset = 0
    }

    const day = bjDayKey(now)
    if (day !== state.dayKey) {
      state.dayKey = day
      state.todayCost = 0
      state.callsToday = 0
      state.todayTokens = 0
      state.todayInput = 0
      state.todayOutput = 0
      state.todayCacheRead = 0
      state.todayCacheWrite = 0
    }

    for (const line of state.tailer.drain()) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let rec
      try {
        rec = JSON.parse(trimmed)
      } catch {
        continue
      }
      const ts = num(rec.timestamp)
      if (ts <= 0) continue
      if (bjDayKey(ts) !== day) continue // 只统计北京时间今天

      const key = String(rec.sessionId || '') + '#' + String(rec.sourceEventSeq ?? rec.step ?? '')
      if (state.seen.has(key)) continue
      state.seen.add(key)

      const cost = num(rec.cost)
      const input = num(rec.inputTokens)
      const output = num(rec.outputTokens)
      const cacheRead = num(rec.cacheReadTokens)
      const cacheWrite = num(rec.cacheWriteTokens)
      // 总量必须含缓存 —— 只加 input + output 会少报 77 倍（见文件头）。飘字/受击
      // 用的是 cost（人民币），这里的 tokens 是给信息条和面板看的量。
      const tokens = input + output + cacheRead + cacheWrite
      state.todayCost += cost
      state.todayTokens += tokens
      // 账本里的 inputTokens 是**未命中缓存**的那部分（它按 input 价计费，
      // cacheReadTokens 才按 cacheHit 价计费 —— 拿 costInput / costCache 对得上），
      // 所以命中率 = cacheRead / (cacheRead + input)，正是 cachehit 的 'aside' 口径。
      state.todayInput += input
      state.todayOutput += output
      state.todayCacheRead += cacheRead
      state.todayCacheWrite += cacheWrite
      state.callsToday += 1
      state.lastCallAt = ts
      state.lastModel = rec.model || state.lastModel
      state.updatedAt = now

      // 只有「本次轮询窗口内新到的」才触发受击，而且**首轮一律不播**（seed）。
      //
      // 为什么要 seed：冷启动时账本是从头读的，近 1 小时的账会**一次性**灌进来。
      // 一轮问答就有十几条记录，按费用构成还要再拆 2~4 条 —— 实测启动瞬间 543 条飘字，
      // 队列（40 笔）当场被反复挤爆、控制台刷满「丢掉最旧的一笔」。那不是在报账，
      // 是在刷屏；而且这些账上一次运行时早就报过了。口径和 dsh-damage-pulse 一致：
      // 它客户端也是先 `chargeSeeded` 播种，之后才开始受击。
      if (state.seeded && now - ts < 60 * 60 * 1000) {
        for (const part of costParts(rec, num)) {
          emit({
            source: 'dsh',
            amount: part.cost,
            unit: 'CNY',
            at: ts,
            level: part.level,          // 档位由本插件定（见 costParts），不走 meta.damage 阈值
            label: part.label,          // 飘字后缀：命中 / 输出 / 未命中 / 缓存写入
            kind: part.kind,
            tokens,
            cacheRead,
            model: rec.model || '',
            id: key + ':' + part.kind,
          })
        }
      }
    }

    // 这一轮读到的都算「见过」了，下一轮起才播 —— 见上面 seed 那段。
    state.seeded = true

    if (state.seen.size > 20000) {
      // 长期挂着时别让去重集合无限涨；offset 已经保证不重读，这里只是保险
      state.seen = new Set([...state.seen].slice(-2000))
    }
    state.detail = 'usage.jsonl · 今日 ' + state.callsToday + ' 次'
  }

  /** 峰谷表：读 DSH 插件落盘的 state.json，拿不到就用内置默认。 */
  function pricePeakHours() {
    try {
      const st = JSON.parse(fs.readFileSync(STATE, 'utf8'))
      const hours = st?.priceTable?.peakHours
      if (Array.isArray(hours) && hours.length > 0) return hours
    } catch { /* 用默认 */ }
    return [[9, 12], [14, 18]]
  }

  return {
    get available() { return state.available },
    get detail() { return state.detail },
    poll,
    pricePeakHours,
    raw(now) {
      const cc = api.cacheHit.split({ mode: 'aside', input: state.todayInput, hit: state.todayCacheRead, write: state.todayCacheWrite })
      return {
        available: state.available,
        todayCost: state.todayCost,
        todayTokens: state.todayTokens,
        todayInput: state.todayInput,
        todayOutput: state.todayOutput,
        todayCacheRead: state.todayCacheRead,
        todayCacheWrite: state.todayCacheWrite,
        callsToday: state.callsToday,
        lastCallAt: state.lastCallAt,
        lastModel: state.lastModel,
        active: now - state.updatedAt < 90 * 1000,
        // 命中率的原料：面板对**所有**来源用同一对键名，所以口径已经在插件里归一到
        // (命中, 未命中) —— 面板不需要知道 DSH 的 input 含不含缓存。
        cacheHitTokens: cc.hit,
        cacheMissTokens: cc.miss,
      }
    },
    fields(now, ctx) {
      const out = []
      const has = state.available && state.callsToday > 0
      // 悬停明细里必须把四项拆开：token 总量被缓存命中撑到 2269 万，
      // 只给一个总数的话，用户第一反应是「怎么涨了 77 倍」。
      const breakdown = '  输入（未命中缓存）' + ctx.fmtTokens(state.todayInput)
        + ' · 输出 ' + ctx.fmtTokens(state.todayOutput) + '\n'
        + '  缓存命中 ' + ctx.fmtTokens(state.todayCacheRead)
        + (state.todayCacheWrite ? ' · 缓存写入 ' + ctx.fmtTokens(state.todayCacheWrite) : '')
        + '（命中的部分按缓存价计费）'
      out.push({
        id: 'dsh',
        label: 'DSH 今日',
        // 单位统一成 token（和其余来源一致），花的钱放进悬停明细 —— 信息条上
        // 混排 ¥ 和 token 会让人以为是两种东西，其实看的是同一笔调用。
        value: has ? ctx.fmtTokens(state.todayTokens) + ' · ' + state.callsToday + ' 次' : '--',
        unit: has ? 'token' : '',
        tone: has ? '' : 'off',
        title: has
          ? 'DSH 今日 ' + ctx.fmtTokens(state.todayTokens) + ' tokens · ' + state.callsToday + ' 次调用\n'
            + breakdown + '\n'
            + '  花费 ¥' + ctx.fmtAmount(state.todayCost) + '（按峰谷价）'
          : (state.available ? '账本里今天还没有记录' : '未找到 dsh-token-monitor 账本'),
      })
      // 缓存命中率：DeepSeek 的隐式缓存，命中部分按 cacheHit 价计费（便宜 50 倍），
      // 所以这个比例直接决定账单。口径见上面 todayInput 的注释。
      const co = { mode: 'aside', input: state.todayInput, hit: state.todayCacheRead, write: state.todayCacheWrite }
      const cr = api.cacheHit.rate(co)
      if (cr) {
        // 命中价是输入价的 1/50 —— 这个倍数写进 detail 的第二行不够具体，补一句；
        // 但别再多写「越高越省」，那半句 detail 里已经有了。
        const lines = ['prompt 缓存命中 ' + cr.pct.toFixed(1) + '%（今日 ' + state.callsToday + ' 次调用）']
          .concat(api.cacheHit.detail(co, ctx.fmtTokens))
        lines.push('  命中部分按缓存价计费，约是输入价的 1/50（DeepSeek 官方价目表）')
        out.push({
          id: 'dshcache',
          label: 'DSH 缓存命中',
          value: cr.pct.toFixed(1) + '%',
          tone: api.cacheHit.tone(cr.pct),
          title: lines.join('\n'),
        })
      } else {
        out.push({ id: 'dshcache', label: 'DSH 缓存命中', value: '--', tone: 'off', title: api.cacheHit.EMPTY_HINT })
      }

      const b = ctx.balance || {}
      // 余额查不到就整段不显示，不要留个刺眼的占位。
      // 显示的是**实时值**（`live` = 官方校准值 − 校准之后读到的扣费），所以每笔扣费
      // 一到它就往下走，不用等下一个 60s；官方原值放在悬停提示里，点一下就知道差多少。
      const shown = Number.isFinite(b.live) ? b.live : b.value
      if (b.supported && Number.isFinite(shown)) {
        const drift = Number.isFinite(b.value) ? b.value - shown : 0
        out.push({
          id: 'balance',
          label: '余额',
          value: '¥' + ctx.fmtAmount(shown),
          tone: '',
          title: 'DeepSeek 账户余额 ¥' + ctx.fmtAmount(shown)
            + (drift > 0.0005 ? '（官方校准值 ¥' + ctx.fmtAmount(b.value) + '，本次校准后又实时扣掉 ¥'
              + ctx.fmtAmount(drift) + '）' : '（60 秒校准一次）')
            + (b.available === false ? '（余额不可用）' : ''),
        })
      } else if (!b.supported) {
        out.push({ id: 'balance', label: '余额', value: '已关闭', tone: 'off', title: '余额查询已关闭（WHALEPET_NO_BALANCE=1）' })
      }
      return out
    },
  }
}

module.exports = { meta, create, costParts, COST_PARTS }
