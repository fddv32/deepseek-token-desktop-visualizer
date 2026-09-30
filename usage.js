// 用量编排层 v3
//
// 职责只有三件：
//   1. 按配置装载/卸载插件（providers/ 下的独立模块），把结果汇总成 snapshot；
//   2. 把「显示在桌宠信息条上的字段」编排成一个有序列表（fields）—— 每个字段的
//      label / value / unit / tone 全在这边算好，渲染端只负责画；
//   3. 把每次扣费定成一个受击**档位**（level：weak / normal / critical）并配好
//      「-多少」那句文案，渲染端只认这两个 —— 至于每个档位播哪一段动画，
//      是用户在设置里排的名单（shared/triggers.js），这边不管。
//
// 配置在 usage.json：
//   {
//     "installed": { "workbuddy": true, "dsh": false },  // 装了哪些插件（false = 已卸载）
//     "fields":    ["today", "ctx", "workbuddy"]         // 信息条上显示哪些字段、什么顺序
//   }
//
// 加一个数据源不需要动这个文件：写一个 providers/xxx.js，声明 meta.fields 就行
// （见 providers/README.md 和 providers/_template.js）。
'use strict'

const fs = require('fs')
const https = require('https')
const os = require('os')
const path = require('path')

const registry = require('./providers')

const CONFIG_PATH = path.join(__dirname, 'usage.json')

const DISABLED = process.env.WHALEPET_USAGE === '0'
const POLL_MS = Number(process.env.WHALEPET_USAGE_MS) > 0 ? Number(process.env.WHALEPET_USAGE_MS) : 2500
// 上下文窗口：日志里的 threshold=90.0% 只是压缩触发线，实测 totalTokens 涨到 21 万仍继续，
// 所以取本地库里 session_usage.size 的口径（30 万）。这个值只用于显示百分比，可用环境变量覆盖。
const CTX_LIMIT = Number(process.env.WHALEPET_CTX_LIMIT) > 0 ? Number(process.env.WHALEPET_CTX_LIMIT) : 300000

/* ---------- 配置 ---------- */

// 默认全装（等价于迁移前的行为）：装是装了，但只有 DEFAULT_FIELDS 里的才会挂到信息条上。
// 卸载过的插件下次启动不会自己装回来 —— 那是用户的明确选择。
const DEFAULT_INSTALLED = { workbuddy: true, dsh: true, codex: true, claude: true, zcode: true }
const DEFAULT_FIELDS = ['today', 'ctx', 'workbuddy', 'wbcache', 'dsh']

function loadConfig() {
  let raw = {}
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  } catch { /* 首次运行或文件损坏，用默认 */ }
  // 旧版本这个键叫 enabled，含义完全一样（这个插件装没装）。留一行兼容，别让老配置失效。
  const installed = raw.installed || raw.enabled || {}
  return {
    installed: { ...DEFAULT_INSTALLED, ...installed },
    fields: Array.isArray(raw.fields) ? raw.fields.filter(x => typeof x === 'string') : DEFAULT_FIELDS.slice(),
  }
}

let config = loadConfig()

function saveConfig(patch) {
  config = {
    installed: { ...config.installed, ...(patch.installed || {}) },
    fields: Array.isArray(patch.fields) ? patch.fields.slice() : config.fields,
  }
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8')
  } catch { /* 写不了就只在内存里生效 */ }
  return config
}

/* ---------- 一笔账显示成什么 ----------
 * 「用多少扣多少」：每个来源照**它自己的量纲**报账 —— WorkBuddy 报积分、DSH 报人民币、
 * Codex / Claude / ZCode 报 token。编排层不换算、不累计，只把这一笔的数值和单位
 * 排成一句能直接飘在鱼身上的文案。
 *
 * 为什么不折算成统一量纲：折算要一张价目表，而价目表是**会跟实际账单脱节的**。
 * 真实花费账本里本来就写好了（DSH 的 cost 是它自己按峰谷价算出来的），
 * 再折一遍只会多出第二套口径 —— 用户想知道的是「花了多少积分 / 多少钱」，
 * 不是按某个默认单价估出来的数。
 */

/** 去掉「0.090」这种尾巴上的零，小数字读起来才干净。 */
function trimZero(s) {
  return s.indexOf('.') < 0 ? s : s.replace(/\.?0+$/, '')
}

/**
 * 数字部分的格式。小额必须看得见小数：DSH 一笔调用就是 ¥0.004 上下，
 * 粗一档就只剩「<0.001」，等于把「用多少扣多少」这句话抹掉了。
 */
function fmtHit(amount) {
  const v = Number(amount)
  if (!Number.isFinite(v) || v <= 0) return '0'
  if (v >= 1000) return trimZero(v.toFixed(1))
  if (v >= 1) return trimZero(v.toFixed(2))
  if (v >= 0.001) return trimZero(v.toFixed(3))
  return '<0.001'
}

/**
 * 「-」后面那半句：数值 + 小字单位。
 *   credit -> 0.09（积分）      WorkBuddy 的 credit 就是积分本身
 *   CNY    -> ¥0.004            DSH / 手动记账记的是人民币
 *   token  -> 1.2万（token）    其余来源只报 token
 * 渲染端拿到就直接画，不做任何格式化 —— 和 fields 一个道理。
 */
function hitOf(amount, unit) {
  if (unit === 'CNY') return { hitValue: '¥' + fmtHit(amount), hitUnit: '' }
  if (unit === 'credit') return { hitValue: fmtHit(amount), hitUnit: '积分' }
  return { hitValue: fmtTokens(amount), hitUnit: 'token' }
}

/* ---------- 受击档位 ----------
 * 各来源量纲不同，阈值也就各不相同：WorkBuddy 的积分单笔约 0.09~0.5；DSH 的 cost 是
 * 人民币，单笔约 0.002~0.012；Codex / Claude / ZCode 报的是 token，单笔常见 1~8 万。
 * 所以阈值由**插件自己**在 meta.damage 里声明（[[该来源量纲的下限, 档位], ...]，从高到低），
 * 编排层不维护一张按来源 id 写死的表 —— 加插件不用改这里。
 */

/* 档位（tier）：这笔账算轻、算中、还是算重。
 *
 * 它是**档位，不是动作名**。以前这里直接返回 'pain-weak' / 'pain-normal' /
 * 'critical' —— 那正好也是动作 id，于是「多大的账播哪一段」被写死在代码里：想让
 * 大额扣费换个动作，只能改代码。现在这里只说「这笔算重的」，渲染端再去「扣费反应」
 * 名单里取第 3 个动作，而名单是用户在设置里排的（见 shared/triggers.js）。
 *
 * 档位比动作少一层：金额只分三档，名单里有几个就用几个 —— 名单只剩两个动作时，
 * 最重的那笔用最后一个（见 renderer/pet.js 的 hitClipFor）。这样删动作不会让
 * 「暴击」突然没反应。
 */
const TIERS = ['weak', 'normal', 'critical']

/* 老插件里写的是动作名，这里认。用户自己写的插件不该因为我们改了内部命名就静默失灵。 */
const TIER_ALIAS = { 'pain-weak': 'weak', 'pain-normal': 'normal' }

function tierOf(name) {
  const t = TIER_ALIAS[name] || name
  // 认不出来就当中等：比默默降成「轻」（看起来像没反应）更接近原意，也不至于崩
  return TIERS.indexOf(t) >= 0 ? t : 'normal'
}

const DEFAULT_DAMAGE = [[1, 'normal']]

function damageLevel(amount, table) {
  const rules = (table && table.length ? table : DEFAULT_DAMAGE)
  const amt = Number(amount) || 0
  for (const [min, level] of rules) {
    if (amt >= min) return tierOf(level)
  }
  return 'weak' // 连表里最低一档都没到
}

/**
 * 给每条账配上「-多少」的文案。
 *
 * **一笔一个，不合并、不累计。** 这是刻意的：一轮采集常常带回来十几条记录
 * （一次用户回合会产生很多段模型调用），把它们加成一个数虽然好读，但看到的是
 * 「-3.5」，看不到底下其实是 0.3、0.1、0.1…… 那一串真实的扣费。
 * 用户想看的就是后者的节奏感，所以这里只如实逐条排版，拥挤的问题交给渲染端
 * （它会把这些数字排成队一个一个飘出来，见 renderer/pet.js）。
 *
 * 唯一做的整理是补上缺省的 `unit`（没报量纲的按 token 算），别让渲染端拿到 undefined。
 */
function decorateEvents(events) {
  const out = []
  for (const ev of events) {
    const unit = ev.unit || 'token'
    out.push({ ...ev, unit, ...hitOf(ev.amount, unit) })
  }
  return out
}

/* ---------- 格式化（注入给插件，也用于核心字段） ---------- */

function fmtTokens(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return '0'
  if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿'
  if (v >= 1e4) return (v / 1e4).toFixed(1) + '万'
  if (v >= 1000) return (v / 1e3).toFixed(1) + 'K'
  return String(Math.round(v))
}

function fmtAmount(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return '0'
  // 小数一定要留着：信息条上这个数字是用来「看着它一笔一笔往上爬」的，
  // 取整会让每次 0.1 的变动完全消失（138.97 显示成 139，看着像没动过）。
  if (v >= 1000) return v.toFixed(1)
  if (v >= 1) return v.toFixed(2)
  return v.toFixed(3)
}

/* ---------- 北京时间 ---------- */

const BJ_OFFSET_MS = 8 * 60 * 60 * 1000

function bjParts(ts) {
  const d = new Date(ts + BJ_OFFSET_MS)
  return {
    y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
    hh: d.getUTCHours(), mm: d.getUTCMinutes(), dow: d.getUTCDay(),
  }
}

function bjDayKey(ts) {
  const p = bjParts(ts)
  return p.y * 10000 + p.m * 100 + p.d
}

/** 峰谷：DeepSeek 官方口径 —— 工作日 09:00-12:00、14:00-18:00 为高峰，周末整日谷价。 */
function peakState(ts) {
  const p = bjParts(ts)
  const weekend = p.dow === 0 || p.dow === 6
  const minutes = p.hh * 60 + p.mm
  const inPeak = !weekend && ((minutes >= 540 && minutes < 720) || (minutes >= 840 && minutes < 1080))
  return { isPeak: inPeak, label: inPeak ? '高峰价' : '谷时价', weekend }
}

/* ---------- DeepSeek 余额（可选，会联网） ----------
 * 和插件一样查官方 GET /user/balance。API Key 从 DSH 自己的凭据文件里取，
 * 只用于这一条请求：不写盘、不进日志、不外发到任何其他地址。
 * 关掉：WHALEPET_NO_BALANCE=1；也可以用 DEEPSEEK_API_KEY 直接给。
 */
const BALANCE_DISABLED = process.env.WHALEPET_NO_BALANCE === '1'
const BALANCE_INTERVAL_MS = 60 * 1000
const DSH_CREDENTIALS = path.join(os.homedir(), '.dsh', '.credentials.yaml')

const balance = {
  supported: !BALANCE_DISABLED,
  value: null,
  currency: 'CNY',
  available: null,
  fetchedAt: 0,
  error: '',
  inFlight: false,
}

function readDeepseekKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  try {
    const text = fs.readFileSync(DSH_CREDENTIALS, 'utf8')
    const m = /DEEPSEEK_API_KEY:\s*["']?([^"'\s]+)["']?/.exec(text)
    return m ? m[1] : ''
  } catch {
    return ''
  }
}

function refreshBalance() {
  if (BALANCE_DISABLED || balance.inFlight) return
  const key = readDeepseekKey()
  if (!key) {
    balance.error = 'no-key'
    return
  }
  balance.inFlight = true
  const req = https.request({
    hostname: 'api.deepseek.com',
    path: '/user/balance',
    method: 'GET',
    headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
    timeout: 12000,
  }, res => {
    let body = ''
    res.setEncoding('utf8')
    res.on('data', chunk => { body += chunk })
    res.on('end', () => {
      balance.inFlight = false
      if (res.statusCode !== 200) {
        balance.error = 'http-' + res.statusCode
        return
      }
      try {
        const obj = JSON.parse(body)
        const infos = Array.isArray(obj.balance_infos) ? obj.balance_infos : []
        const pick = infos.find(x => String(x.currency).toUpperCase() === 'CNY') || infos[0]
        if (!pick) {
          balance.error = 'empty'
          return
        }
        const val = Number(pick.total_balance)
        if (!Number.isFinite(val)) {
          balance.error = 'bad-value'
          return
        }
        balance.value = val
        balance.currency = pick.currency || 'CNY'
        balance.available = obj.is_available === true
        balance.fetchedAt = Date.now()
        balance.error = ''
      } catch {
        balance.error = 'parse'
      }
    })
  })
  req.on('error', err => {
    balance.inFlight = false
    balance.error = String((err && err.code) || (err && err.message) || 'error')
  })
  req.on('timeout', () => {
    req.destroy()
    balance.inFlight = false
    balance.error = 'timeout'
  })
  req.end()
}

/* ---------- 插件装载 ---------- */

const instances = new Map() // id -> { def, inst }
let loadErrors = []
let loadedAt = 0

function safe(fn, fallback) {
  try {
    return fn()
  } catch {
    return fallback
  }
}

function isInstalled(id) {
  return config.installed[id] !== false
}

function reload() {
  const { providers, errors } = registry.list()
  loadErrors = errors.slice()
  instances.clear()
  for (const def of providers) {
    if (!isInstalled(def.meta.id)) continue
    const inst = registry.instantiate(def)
    if (inst) instances.set(def.meta.id, { def, inst })
  }
  loadedAt = Date.now()
  return listProviders()
}

/** 插件声明的字段 id 列表。 */
function fieldIdsOf(id) {
  const hit = instances.get(id)
  const meta = hit ? hit.def.meta : (registry.list().providers.find(p => p.meta.id === id) || {}).meta
  return meta && meta.fields ? meta.fields.map(f => f.id) : []
}

/** 给设置面板用的插件清单（含「有哪些字段可选」）。 */
function listProviders() {
  const { providers, errors } = registry.list()
  return {
    userDir: registry.USER_DIR,
    errors: [...errors, ...loadErrors].filter(Boolean),
    providers: providers.map(def => {
      const inst = instances.get(def.meta.id)
      return {
        id: def.meta.id,
        label: def.meta.label,
        vendor: def.meta.vendor,
        badge: def.meta.badge,
        desc: def.meta.desc,
        unit: def.meta.unit,
        paths: def.meta.paths,
        builtin: def.meta.builtin,
        userLevel: def.userLevel,
        fields: def.meta.fields || [],
        installed: isInstalled(def.meta.id),
        loaded: !!inst,
        available: !!(inst && inst.inst.available),
        detail: inst ? String(inst.inst.detail || '') : '',
        loadedAt,
        file: def.file,
        sample: inst ? safe(() => inst.inst.raw(Date.now()), null) : null,
      }
    }),
  }
}

/**
 * 安装 / 卸载一个插件。
 * 卸载 = 不再装载它（不读它的日志、不占内存），并把它的字段从信息条上摘掉。
 * 文件不动 —— 内置插件本来就该能随时装回来，用户插件想彻底删走 deleteProvider()。
 */
function installProvider(id, on) {
  config = saveConfig({ installed: { [id]: !!on } })
  if (!on) {
    const drop = fieldIdsOf(id)
    if (drop.length) config = saveConfig({ fields: config.fields.filter(f => !drop.includes(f)) })
  }
  reload()
  return { config: publicConfig(), providers: listProviders() }
}

/** 删除用户级插件的文件（内置插件拒绝：删了下次更新又会回来，等于没删）。 */
function deleteProvider(id) {
  const def = registry.list().providers.find(p => p.meta.id === id)
  if (!def) return { ok: false, message: '没有这个插件' }
  if (def.meta.builtin) return { ok: false, message: '内置插件不能删除文件，卸载它即可' }
  try {
    fs.unlinkSync(def.file)
  } catch (err) {
    return { ok: false, message: '删除失败：' + String((err && err.message) || err) }
  }
  // 顺手摘掉它的字段；installed 恢复成默认（下次把文件放回来就自动装上）
  const drop = (def.meta.fields || []).map(f => f.id)
  config = saveConfig({ fields: config.fields.filter(f => !drop.includes(f)) })
  delete config.installed[id]
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8') } catch { /* 忽略 */ }
  reload()
  return { ok: true }
}

/* ---------- 核心字段 ---------- */

/**
 * 「今日已用」—— 把各来源今天的量汇总成一个数。
 *
 * 各家单位不同，**不做换算**：token 归 token、积分归积分，并排显示。
 * 数字直接取自各插件 raw() 里的 todayTokens / todayCredit，插件不需要为这个字段做任何事
 * （约定见 providers/README.md），所以以后加一个插件它自动出现在这里。
 */
function todayField(raw, labels) {
  let tokens = 0
  let credits = 0
  const lines = []
  for (const [id, r] of Object.entries(raw)) {
    const name = labels[id] || id
    const t = Number(r && r.todayTokens) || 0
    const c = Number(r && r.todayCredit) || 0
    if (t > 0) { tokens += t; lines.push('  ' + name + '  ' + fmtTokens(t) + ' token') }
    if (c > 0) { credits += c; lines.push('  ' + name + '  ' + fmtAmount(c) + ' 积分') }
  }
  const parts = []
  if (tokens > 0) parts.push(fmtTokens(tokens) + ' token')
  if (credits > 0) parts.push(fmtAmount(credits) + ' 积分')
  return [{
    id: 'today',
    label: '今日已用',
    value: parts.length ? parts.join(' · ') : '--',
    tone: parts.length ? '' : 'off',
    title: parts.length
      ? '今日已用 ' + parts.join(' + ') + '\n按来源：\n' + lines.join('\n')
      : '今天还没有读到任何用量',
  }]
}

function peakField(now) {
  const peak = peakState(now)
  return [{
    id: 'peak',
    label: '',
    value: peak.label,
    tone: peak.isPeak ? 'peak' : 'valley',
    title: '价格时段 ' + peak.label + (peak.weekend ? '（周末整日谷价）' : '')
      + '\n高峰：工作日 09:00-12:00、14:00-18:00',
  }]
}

/** 可选的「核心字段」—— 不依赖任何插件。 */
const CORE = [
  { id: 'today', label: '今日已用', group: 'core', desc: '所有来源今天的合计（token / 积分分开记）' },
  { id: 'peak', label: '价格时段', group: 'core', desc: 'DeepSeek 峰谷价（工作日 09:00-12:00 / 14:00-18:00 为高峰）' },
]

/** 当前「可选字段」全表：核心字段 + 所有**已安装**插件声明的字段。 */
function fieldCatalog() {
  const out = CORE.map(f => ({ ...f, provider: '' }))
  for (const [id, { def }] of instances) {
    for (const f of def.meta.fields || []) {
      const label = f.label || f.id
      out.push({
        id: f.id,
        label,
        group: 'provider',
        provider: id,
        // 来源名和字段名一模一样时不带它。手动记账就是这么个例子：两者都叫「手动记账」，
        // 照搬会渲染成「手动记账 手动记账」和「＋ 手动记账（手动记账）」—— 纯重复。
        providerLabel: def.meta.label && def.meta.label !== label ? def.meta.label : '',
        unit: f.unit || '',
        desc: f.desc || '',
      })
    }
  }
  return out
}

/**
 * 单独造一笔账：定受击档位 + 配好「-多少」的文案。
 *
 * 正常路径在 poll() 里内联做（那儿本来就拿着 def / inst）。这个函数是给
 * 「不经过插件、要手工造一笔账」的场景用的（验收用的伪扣费 WHALEPET_FAKE_HIT）——
 * 关键是它和真实路径**走同一套口径**，否则验收验的是另一条代码。
 */
function eventOf(id, amount, unit) {
  const hit = instances.get(id)
  const meta = hit ? hit.def.meta : null
  const amt = Number(amount) || 0
  const u = unit || (meta && meta.unit) || 'credit'
  return {
    amount: amt,
    unit: u,
    ...hitOf(amt, u),
    level: damageLevel(amt, meta && meta.damage),
  }
}

function publicConfig() {
  return {
    installed: { ...config.installed },
    fields: config.fields.slice(),
    catalog: fieldCatalog(),
  }
}

function setFields(ids) {
  const valid = new Set(fieldCatalog().map(f => f.id))
  config = saveConfig({ fields: ids.filter(id => valid.has(id)) })
  return publicConfig()
}

/* ---------- 采集 ---------- */

/**
 * 采一次。返回 { snapshot, events }。
 * events 是本次轮询新出现的用量账，**一笔一条**（不合并），每条都带着受击档位
 * 和「-多少」的文案，供渲染端播动画 + 逐笔飘数字。
 */
function poll(now) {
  const ts = Number.isFinite(now) ? now : Date.now()
  const events = []

  if (!DISABLED) {
    for (const [id, { def, inst }] of instances) {
      try {
        inst.poll(ts, ev => {
          // 只定等级：数字和单位原样留着，由主进程排版成「-多少」（见 decorateEvents）。
          events.push({
            ...ev,
            source: ev.source || id,
            level: damageLevel(ev.amount, def.meta.damage),
          })
        })
      } catch { /* 单个插件崩了不影响桌宠 */ }
    }

    // 余额在后台异步查，不阻塞这一轮采集
    if (balance.supported && !balance.inFlight && ts - balance.fetchedAt > BALANCE_INTERVAL_MS) {
      refreshBalance()
    }
  }

  const ctx = { ctxLimit: CTX_LIMIT, fmtTokens, fmtAmount, balance }

  const raw = {}
  const labels = {}
  const byId = new Map()
  for (const [id, { def, inst }] of instances) {
    labels[id] = def.meta.label
    const data = safe(() => inst.raw(ts), null)
    if (data) raw[id] = data
    for (const f of safe(() => inst.fields(ts, ctx), []) || []) {
      if (f && f.id) byId.set(f.id, f)
    }
  }
  for (const f of todayField(raw, labels)) byId.set(f.id, f)
  for (const f of peakField(ts)) byId.set(f.id, f)

  const known = new Set(fieldCatalog().map(f => f.id))
  // 配置里引用了不存在的字段（插件被卸载/删了）就跳过，但**不改配置** ——
  // 插件装回来，字段也就跟着回来。
  const fields = config.fields.filter(id => known.has(id)).map(id => byId.get(id)).filter(Boolean)

  const snapshot = {
    time: ts,
    disabled: DISABLED,
    peak: peakState(ts),
    ctxLimit: CTX_LIMIT,
    pollMs: POLL_MS,
    fields,
    providers: raw,
    // 兼容旧字段：test-usage.js / 诊断脚本还在读这两块。用默认值打底，
    // 这样即使对应插件被卸载了，这些老脚本也不会因为读到 undefined 而崩。
    workbuddy: { available: false, ctxTokens: 0, todayCredit: 0, callsToday: 0, active: false, ...(raw.workbuddy || {}) },
    dsh: {
      available: false, todayCost: 0, todayTokens: 0, callsToday: 0, lastModel: '',
      ...(raw.dsh || {}),
      balance: {
        supported: balance.supported,
        value: balance.value,
        currency: balance.currency,
        available: balance.available,
        error: balance.error,
        fetchedAt: balance.fetchedAt,
      },
    },
    plugins: {
      loaded: [...instances.keys()],
      errors: loadErrors.length,
    },
  }

  return { snapshot, events: decorateEvents(events) }
}

/* ---------- 导出 ---------- */

/** 峰谷表（读 DSH 插件落盘的 state.json，拿不到就用内置默认）。 */
function dshPricePeakHours() {
  const hit = instances.get('dsh')
  if (hit && typeof hit.inst.pricePeakHours === 'function') {
    return safe(() => hit.inst.pricePeakHours(), [[9, 12], [14, 18]])
  }
  return [[9, 12], [14, 18]]
}

reload()

module.exports = {
  poll,
  peakState,
  bjDayKey,
  POLL_MS,
  CTX_LIMIT,
  DISABLED,
  dshPricePeakHours,
  // 一笔账的显示与轻重（单笔文案，不累计）
  hitOf,
  fmtHit,
  damageLevel,
  TIERS,
  tierOf,
  decorateEvents,
  eventOf,
  // 设置面板
  listProviders,
  installProvider,
  deleteProvider,
  fieldCatalog,
  publicConfig,
  setFields,
  reload,
}
