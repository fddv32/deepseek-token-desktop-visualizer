// 每日用量账本：把「今天用了多少」按自然日存下来。
//
// 为什么需要它：桌宠自己只算「今天」—— 每轮 poll 拿到的都是各来源的**当日累计**，
// 进程一退就没了。用量面板要画折线图、要看「这周比上周多花多少」，就必须有人
// 在每天过完之前把那个数字钉住。
//
// 记的是**当日累计的最新值**，不是增量：同一天里反复覆盖同一行，跨天自动开新行。
// 这样中间丢几轮 poll 也不影响结果 —— 下一轮的累计值本来就包含前面那些。
//
// 量纲不统一是这一层的核心难点：WorkBuddy 报**积分**，DSH 报**人民币**，
// Codex / Claude / ZCode 报 **token**。这里**不做任何换算**（单价会变，换出来的数是假的），
// 四样分开记，由面板自己决定画哪一条。这和「扣费飘字不折算」是同一条原则。
//
// 纯逻辑（dayKey / entryOf / merge / prune / summarize）不碰 fs，node 能直接 require 来测；
// 只有 createStore 负责落盘。
'use strict'

const VERSION = 1
const KEEP_DAYS = 180      // 只留半年：再多面板也画不下，文件还一直长
const FLUSH_MS = 15000     // 落盘节流：poll 2.5 秒一轮，每轮写盘既没必要也伤盘
const METRICS = ['tokens', 'cost', 'credit', 'calls']

/** 本地时区的自然日键（YYYY-MM-DD）。**必须用本地时区** —— 用户嘴里的「今天」是他表上的今天。 */
function dayKey(ts) {
  const d = new Date(ts)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 把 "YYYY-MM-DD" 解析回当天 00:00 的时间戳（本地时区）。 */
function dayStart(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key))
  if (!m) return NaN
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
}

const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0)

/**
 * 从一份 usage 快照里抽出「今天各来源用了多少」。
 *
 * 字段名来自各插件 raw() 的约定，这里只搬运、不判断 —— 插件没提供就当 0
 * （比如 WorkBuddy 只报积分，压根没有 token 这个概念）。
 */
function entryOf(snapshot) {
  const p = (snapshot && snapshot.providers) || {}
  const out = {}
  if (p.workbuddy) {
    out.workbuddy = { credit: num(p.workbuddy.todayCredit), calls: num(p.workbuddy.callsToday) }
  }
  if (p.dsh) {
    out.dsh = { tokens: num(p.dsh.todayTokens), cost: num(p.dsh.todayCost), calls: num(p.dsh.callsToday) }
  }
  for (const id of ['codex', 'claude', 'zcode']) {
    if (p[id]) out[id] = { tokens: num(p[id].todayTokens), calls: num(p[id].callsToday) }
  }
  if (p.manual) {
    out.manual = { tokens: num(p.manual.todayTokens), cost: num(p.manual.todayCost), calls: num(p.manual.callsToday) }
  }
  return out
}

/** 把多个来源合成一行合计。四种量纲各自求和，互不换算。 */
function totalOf(entry) {
  const t = { tokens: 0, cost: 0, credit: 0, calls: 0 }
  for (const [id, one] of Object.entries(entry || {})) {
    if (id === 'total') continue
    for (const k of METRICS) t[k] += num(one && one[k])
  }
  return t
}

/**
 * 把一轮采集并进账本，返回**新的** days（不改原对象）。
 *
 * 同日覆盖，但要防一手「账往回走」：插件重载后它的累计器是从零重建的，
 * 中间有几百毫秒会报出比刚才小的数（实测 WorkBuddy 重载后短暂报 0）。
 * 直接覆盖的话，那一下就把当天已经攒下的量抹掉了 —— 所以逐项取 max。
 */
function merge(days, key, entry) {
  const prev = (days && days[key]) || {}
  const next = { ...prev }
  for (const [id, one] of Object.entries(entry || {})) {
    if (id === 'total') continue
    const old = prev[id] || {}
    const merged = {}
    for (const k of METRICS) {
      const a = num(old[k])
      const b = num(one && one[k])
      if (a || b) merged[k] = Math.max(a, b)
    }
    next[id] = merged
  }
  next.total = totalOf(next)
  return { ...days, [key]: next }
}

/** 只留最近 keep 天。YYYY-MM-DD 的字典序就是时间序，直接排即可。 */
function prune(days, keep = KEEP_DAYS) {
  const keys = Object.keys(days || {}).sort()
  if (keys.length <= keep) return days
  const out = {}
  for (const k of keys.slice(-keep)) out[k] = days[k]
  return out
}

/** 取某个范围内的日期键（含今天），按时间升序。 */
function keysIn(days, range, now) {
  const keys = Object.keys(days || {}).sort()
  if (range === 'all') return keys
  const days1 = range === 'today' ? 0 : range === '7d' ? 6 : range === '30d' ? 29 : 0
  const from = dayStart(dayKey(now)) - days1 * 86400000
  return keys.filter(k => {
    const t = dayStart(k)
    return Number.isFinite(t) && t >= from && t <= now
  })
}

/**
 * 按范围汇总（给面板顶部的指标卡用）。
 *
 * range: 'today' | '7d' | '30d' | 'all'
 * 返回的 total 是范围内**逐日相加**（不是最后一天的累计值 —— 折线图要的是每天各多少）。
 * 单日那边的「当日累计」语义只活在 days 里。
 */
function summarize(days, range, now) {
  const keys = keysIn(days, range, now)
  const total = { tokens: 0, cost: 0, credit: 0, calls: 0 }
  const bySource = {}
  const series = []
  for (const k of keys) {
    const row = days[k] || {}
    const t = row.total || totalOf(row)
    for (const m of METRICS) total[m] += num(t[m])
    series.push({ day: k, ...t })
    for (const [id, one] of Object.entries(row)) {
      if (id === 'total') continue
      const acc = bySource[id] || (bySource[id] = { tokens: 0, cost: 0, credit: 0, calls: 0 })
      for (const m of METRICS) acc[m] += num(one && one[m])
    }
  }
  const activeDays = keys.filter(k => num(((days[k] || {}).total || {}).calls) > 0).length
  return {
    range,
    days: keys.length,
    activeDays,
    total,
    series,
    bySource,
    // 均价类指标只在有量的时候才算 —— 除零算出来是 Infinity，JSON 里还会变成 null，
    // 面板上就成了「—」，不如这里直接给 0 让调用方自己判断。
    perDayCost: activeDays > 0 ? total.cost / activeDays : 0,
    perDayTokens: activeDays > 0 ? total.tokens / activeDays : 0,
    per100mTokens: total.tokens > 0 ? (total.cost / total.tokens) * 1e8 : 0,
  }
}

/**
 * 带落盘的账本。
 *
 * 读的时候容错：文件不在、JSON 坏了、版本对不上，都当成空账本重新开始 ——
 * 这是「统计历史」，丢了不该拦住桌宠启动。
 */
function createStore(fs, file) {
  let days = {}
  let dirty = false
  let lastFlush = 0
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (raw && raw.version === VERSION && raw.days && typeof raw.days === 'object') days = raw.days
  } catch { /* 首次运行 / 文件损坏：从空开始 */ }

  function flush(force) {
    if (!dirty && !force) return false
    try {
      fs.writeFileSync(file, JSON.stringify({ version: VERSION, days }, null, 2), 'utf8')
      dirty = false
      return true
    } catch { return false }   // 写不了就只在内存里生效，下次再试
  }

  return {
    /** 记一轮。返回是否真的落盘了（给测试和启动报告用）。 */
    record(snapshot, ts) {
      const key = dayKey(ts)
      const before = JSON.stringify(days[key] || null)
      days = prune(merge(days, key, entryOf(snapshot)))
      if (JSON.stringify(days[key] || null) !== before) dirty = true
      if (dirty && ts - lastFlush >= FLUSH_MS) {
        lastFlush = ts
        return flush(false)
      }
      return false
    },
    flush,
    all: () => days,
    summarize: (range, now) => summarize(days, range, now),
    dayKey,
  }
}

module.exports = {
  VERSION, KEEP_DAYS, FLUSH_MS, METRICS,
  dayKey, dayStart, entryOf, totalOf, merge, prune, keysIn, summarize,
  createStore,
}
