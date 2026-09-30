// providers/workbuddy.js —— WorkBuddy（zcode 协议）用量
//
// 数据源：~/.workbuddy/logs/<日期>/<工作区>__<hash>.log
// 日志里有两类行：
//   [shouldCompact] Added trailing tool result tokens: +834, totalTokens=175474, isSubAgent=false, threshold=90.0%
//   [SessionManager][credit] Credit received: rootRequestId=01a0f1f..., source=raw_model_stream_event, credit=0.83
// 前者是当前会话的实时上下文 token，后者是每次模型调用的计费消耗（按 requestId 一条）。
//
// 为什么不读 ~/.workbuddy/projects/**/*.jsonl（那里有精确的 providerData.rawUsage.credit）：
// 那个 jsonl 只覆盖「本机作为客户端」的会话，运行时日志覆盖全部调用，而且
// **上下文值更实时**（shouldCompact 是边跑边写的）。两者口径略有差异，这里选日志。
//
// 为什么不读 workbuddy.db：Electron 33 内置 Node 20 没有 node:sqlite，
// 装 better-sqlite3 要带原生二进制，而日志里同样的数据是纯文本、还能增量读，零依赖更稳。
'use strict'

const meta = {
  id: 'workbuddy',
  label: 'WorkBuddy',
  vendor: '腾讯 WorkBuddy / zcode 协议',
  badge: 'WB',
  builtin: true,
  // WorkBuddy 计的是 credit，桌面上按「积分」显示（用户口径）。其余来源都是 token。
  unit: 'credit',
  paths: ['~/.workbuddy/logs'],
  desc: '读运行时日志：上下文 token（shouldCompact）与每次调用的 credit',
  fields: [
    { id: 'ctx', label: '上下文', desc: '本轮会话的实时上下文 token 占用' },
    { id: 'workbuddy', label: 'WB 今日', unit: 'credit', desc: 'WorkBuddy 今日消耗的积分' },
  ],
  damage: [[3, 'critical'], [1, 'pain-normal']],
}

// 日志正文里换行是 \n；行首锚定可以避开「工具输出把日志内容又打进日志」的自引用污染。
const RE_CTX = /^\[\d{4}\/\d{1,2}\/\d{1,2} [\d:.]+\] \[[^\]]+\] \[pid=\d+\] \[shouldCompact\] Added trailing tool result tokens: \+\d+, totalTokens=(\d+), isSubAgent=(true|false)/
const RE_CREDIT = /^\[\d{4}\/\d{1,2}\/\d{1,2} [\d:.]+\] \[[^\]]+\] \[pid=\d+\] \[SessionManager\]\[credit\] Credit received: rootRequestId=([0-9a-f]+), source=([A-Za-z_]+), credit=([\d.]+)/
const RE_LOG_TS = /^\[(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{2}):(\d{2})\.(\d{3})\]/
const BJ_OFFSET_MS = 8 * 60 * 60 * 1000

function create(api) {
  const { fs, path, bjDayKey, num } = api
  const ROOT = api.expand('~/.workbuddy/logs')

  const state = {
    files: new Map(), // file -> Tailer
    ctxTokens: 0,
    ctxAt: 0,
    ctxModel: '',
    dayKey: 0,
    todayCredit: 0,
    callsToday: 0,
    totalCredit: 0,
    seen: new Set(),
    lastCallAt: 0,
    lastModel: '',
    updatedAt: 0,
    available: false,
    detail: '未找到日志目录',
  }

  /** 日志行首的时间戳是本地（北京时间），转成 UTC 毫秒。 */
  function parseLogTs(line) {
    const m = RE_LOG_TS.exec(line)
    if (!m) return 0
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]) - BJ_OFFSET_MS
  }

  /** 跨天时旧文件还在写，所以取最近两天的目录；再按 mtime 过滤掉早已静止的文件。 */
  function listLogs() {
    let days = []
    try {
      days = fs.readdirSync(ROOT, { withFileTypes: true })
        .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
        .map(e => e.name)
        .sort()
        .slice(-2)
    } catch {
      return []
    }
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    const files = []
    for (const day of days) {
      const dir = path.join(ROOT, day)
      let entries = []
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const ent of entries) {
        if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.log')) continue
        const full = path.join(dir, ent.name)
        try {
          if (fs.statSync(full).mtimeMs < cutoff) continue
        } catch {
          continue
        }
        files.push(full)
      }
    }
    return files
  }

  function poll(now, emit) {
    const files = listLogs()
    state.available = files.length > 0
    if (!state.available) {
      state.detail = fs.existsSync(ROOT) ? '日志目录为空（今天还没用过？）' : '未找到 ~/.workbuddy/logs'
      return
    }

    // 清掉已经不在列表里的 tailer，避免 Map 无限增长
    for (const key of [...state.files.keys()]) {
      if (!files.includes(key)) state.files.delete(key)
    }

    const day = bjDayKey(now)
    if (day !== state.dayKey) {
      state.dayKey = day
      state.todayCredit = 0
      state.callsToday = 0
      state.seen.clear()
    }

    // 首次接入要读全文：信息条一上来就得显示「今天已经花了多少」。
    // 但那些历史行只累计、不发事件 —— 否则一启动就把旧账当成刚扣费，动画会乱放。
    // tailer.armed 就是这个开关：第一次 drain 完才武装。
    for (const file of files) {
      let tailer = state.files.get(file)
      if (!tailer) {
        tailer = new api.Tailer(file)
        tailer.offset = 0
        tailer.armed = false
        state.files.set(file, tailer)
      }

      for (const line of tailer.drain()) {
        let m = RE_CTX.exec(line)
        if (m) {
          if (m[2] === 'false') {
            const val = num(m[1])
            // 同一天可能有多个会话日志（多个工作区），取时间戳最新的那一个，
            // 而不是遍历顺序里最后读到的那个。
            const at = parseLogTs(line)
            if (val > 0 && at >= state.ctxAt) {
              state.ctxTokens = val
              state.ctxAt = at
            }
          }
          continue
        }
        m = RE_CREDIT.exec(line)
        if (!m) continue

        const [, requestId, source, rawCredit] = m
        // response_done 那条是 undefined，只在 stream 事件里取值
        if (source !== 'raw_model_stream_event') continue
        if (state.seen.has(requestId)) continue

        const at = parseLogTs(line) || now
        if (bjDayKey(at) !== day) continue // 昨天收尾时写进当天文件的尾巴，不算今天
        state.seen.add(requestId)

        const credit = num(rawCredit)
        if (credit <= 0) continue
        state.todayCredit += credit
        state.totalCredit += credit
        state.callsToday += 1
        state.lastCallAt = at
        state.updatedAt = at

        if (tailer.armed) {
          emit({ source: 'workbuddy', amount: credit, unit: 'credit', at, id: requestId })
        }
      }
      tailer.armed = true
    }

    // detail 放在采集之后写：计数值这一轮才更新，写在前面会慢一拍
    state.detail = files.length + ' 个活动日志 · 今日 ' + state.callsToday + ' 次'
  }

  return {
    get available() { return state.available },
    get detail() { return state.detail },
    poll,
    raw(now) {
      return {
        available: state.available,
        ctxTokens: state.ctxTokens,
        ctxAt: state.ctxAt,
        todayCredit: state.todayCredit,
        callsToday: state.callsToday,
        totalCredit: state.totalCredit,
        lastCallAt: state.lastCallAt,
        lastModel: state.lastModel,
        active: now - state.updatedAt < 90 * 1000,
      }
    },
    fields(now, ctx) {
      const limit = ctx.ctxLimit
      const out = []
      const used = state.ctxTokens
      if (used > 0 && limit > 0) {
        const pct = used / limit * 100
        out.push({
          id: 'ctx',
          label: '上下文',
          // 不挂单位后缀：value 里已经有 token 数和百分比，再加个 token 反而读不顺
          value: ctx.fmtTokens(used) + ' · ' + pct.toFixed(0) + '%',
          tone: pct >= 90 ? 'danger' : (pct >= 70 ? 'warn' : ''),
          title: '上下文 ' + ctx.fmtTokens(used) + ' / ' + ctx.fmtTokens(limit) + '（' + pct.toFixed(1) + '%）',
        })
      } else {
        out.push({ id: 'ctx', label: '上下文', value: '--', tone: 'off', title: '这一轮还没读到 shouldCompact 记录' })
      }
      out.push({
        id: 'workbuddy',
        label: 'WB 今日',
        // 有数据就显示「5.47 积分」；没有数据时连单位一起收起来，别变成刺眼的「-- 积分」
        value: state.available ? ctx.fmtAmount(state.todayCredit) : '--',
        unit: state.available ? '积分' : '',
        tone: state.available ? '' : 'off',
        title: state.available
          ? 'WorkBuddy 今日消耗 ' + ctx.fmtAmount(state.todayCredit) + ' 积分 · ' + state.callsToday + ' 次调用'
          : '未找到 WorkBuddy 日志',
      })
      return out
    },
  }
}

module.exports = { meta, create }
