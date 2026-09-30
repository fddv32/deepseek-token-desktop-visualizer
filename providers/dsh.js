// providers/dsh.js —— DSH（DeepSeek Harness）用量
//
// 数据源：~/.dsh/data/dsh-token-monitor/usage.jsonl（dsh-token-monitor 插件自己的账本）
// 每行一次调用：
//   {timestamp, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost, sessionId, ...}
// cost 是插件按官方峰谷价算好的人民币金额，直接用，不要自己再乘一遍价目表。
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
    { id: 'dsh', label: 'DSH 今日', unit: 'token', desc: 'DSH 今日的 token 用量（花费见悬停明细）' },
    { id: 'balance', label: 'DeepSeek 余额', desc: '联网查一次官方 /user/balance' },
  ],
  // 受击阈值，单位**人民币** —— 这个插件 emit 的账就是 cost（元），
  // 单位在事件里写明了，编排层原样用，所以「用多少扣多少」飘出来的就是 ¥ 数字。
  // 一次调用约 ¥0.004 上下，0.012 算暴击。
  damage: [[0.012, 'critical'], [0.004, 'normal']],
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
    todayCacheRead: 0,
    lastCallAt: 0,
    lastModel: '',
    updatedAt: 0,
    available: false,
    detail: '',
    seen: new Set(),
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
      state.todayCacheRead = 0
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
      const tokens = num(rec.inputTokens) + num(rec.outputTokens)
      state.todayCost += cost
      state.todayTokens += tokens
      state.todayCacheRead += num(rec.cacheReadTokens)
      state.callsToday += 1
      state.lastCallAt = ts
      state.lastModel = rec.model || state.lastModel
      state.updatedAt = now

      // 只有「本次轮询窗口内新到的」才触发受击：初始化时读到的历史不播
      if (now - ts < 60 * 60 * 1000) {
        emit({
          source: 'dsh',
          amount: cost,
          unit: 'CNY',
          at: ts,
          tokens,
          cacheRead: num(rec.cacheReadTokens),
          model: rec.model || '',
          id: key,
        })
      }
    }

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
      return {
        available: state.available,
        todayCost: state.todayCost,
        todayTokens: state.todayTokens,
        callsToday: state.callsToday,
        lastCallAt: state.lastCallAt,
        lastModel: state.lastModel,
        active: now - state.updatedAt < 90 * 1000,
      }
    },
    fields(now, ctx) {
      const out = []
      const has = state.available && state.callsToday > 0
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
            + '  花费 ¥' + ctx.fmtAmount(state.todayCost) + '（按峰谷价）· 缓存命中 '
            + ctx.fmtTokens(state.todayCacheRead)
          : (state.available ? '账本里今天还没有记录' : '未找到 dsh-token-monitor 账本'),
      })
      const b = ctx.balance || {}
      // 余额查不到就整段不显示，不要留个刺眼的占位
      if (b.supported && Number.isFinite(b.value)) {
        out.push({
          id: 'balance',
          label: '余额',
          value: '¥' + ctx.fmtAmount(b.value),
          tone: '',
          title: 'DeepSeek 账户余额 ¥' + ctx.fmtAmount(b.value) + (b.available === false ? '（余额不可用）' : ''),
        })
      } else if (!b.supported) {
        out.push({ id: 'balance', label: '余额', value: '已关闭', tone: 'off', title: '余额查询已关闭（WHALEPET_NO_BALANCE=1）' })
      }
      return out
    },
  }
}

module.exports = { meta, create }
