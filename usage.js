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
// 每日历史账本（main.js 往里写，这里只读）：「剩余积分」的累计消耗从这来。
const HISTORY_PATH = path.join(__dirname, 'usage-history.json')

const DISABLED = process.env.WHALEPET_USAGE === '0'
/* 采集周期。默认 1 秒 —— 扣费要**实时**：DSH 那个 dsh-damage-pulse 的
 * `CHARGE_POLL_MS` 就是 1e3，桌面上的观感是「这边一调用完，鱼那边马上就掉血」。
 *
 * 敢压到 1s 是因为**一轮几乎不花钱**：首轮要把当天日志读全文（实测 ~40ms），
 * 之后每个来源都走增量 tail，一轮只要 1~4ms（`tools/check-poll-cost.js` 可复跑）。
 * 1s 一轮 ≈ 单核 0.2%。真嫌费电可以用 WHALEPET_USAGE_MS 调回去，余额那边的
 * 60s 校准周期不受它影响（两者独立）。
 */
const POLL_MS = Number(process.env.WHALEPET_USAGE_MS) > 0 ? Number(process.env.WHALEPET_USAGE_MS) : 1000
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
    quota: readQuota(raw.quota),
  }
}

/* ---------- 额度快照 ----------
 *
 * WorkBuddy 没有公开的余额接口（db 和日志里都只有消耗、没有总额度），所以「剩余」
 * 只能算出来：用户在设置里填一次总额度，剩余 = 额度 − 累计消耗。累计从
 * usage-history.json（截至昨天）+ 今天实时值拼出 —— 每天的账历史里都钉着，
 * 重启不会丢。额度本身也可以随时改（升级了就填新数，剩余按新数重算）。
 */
function readQuota(raw) {
  const credit = Number(raw && raw.credit)
  return { credit: Number.isFinite(credit) && credit > 0 ? credit : null }
}

let config = loadConfig()

function saveConfig(patch) {
  config = {
    installed: { ...config.installed, ...(patch.installed || {}) },
    fields: Array.isArray(patch.fields) ? patch.fields.slice() : config.fields,
    quota: patch.quota ? readQuota(patch.quota) : config.quota,
  }
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8')
  } catch { /* 写不了就只在内存里生效 */ }
  return config
}

/** 设置 WorkBuddy 积分总额度。填 0 / 空 = 清掉（不显示剩余）。 */
function setQuota(patch) {
  config = saveConfig({ quota: { credit: Number(patch && patch.credit) > 0 ? Number(patch.credit) : null } })
  return { quota: config.quota }
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
 *
 * 尾部保留到 **1e-6**（不是 <0.001 一刀切）：token 类来源掉血是
 * `token / 1e6 × 0.01`，一次 5 万 token 的调用只有 0.0006 —— 一刀切成「<0.001」
 * 会把这类来源全糊成同一个数，「掉了多少」就看不见了。
 */
function fmtHit(amount) {
  const v = Number(amount)
  if (!Number.isFinite(v) || v <= 0) return '0'
  if (v >= 1000) return trimZero(v.toFixed(1))
  if (v >= 1) return trimZero(v.toFixed(2))
  if (v >= 0.001) return trimZero(v.toFixed(3))
  if (v >= 0.000001) return trimZero(v.toFixed(6))
  return '<0.000001'
}

/* ---------- 掉血（受击时飘的那个数字）----------
 * 各来源报的量纲不一样（积分 / 人民币 / token），飘在鱼身上之前先**归一成一个数**，
 * 这样「这笔账有多疼」在不同来源之间才比得了。口径（用户定的）：
 *
 *   积分 credit   -> 原样，1 积分 = 1 点血
 *   人民币 CNY    -> 原样。DSH / 手动记账报的本来就是钱，DeepSeek 的花费也在里面
 *                    （「用余额表示」），所以不再折算
 *   token         -> 1,000,000 token = 0.01 点血（即 1 亿 token = 1 点血）
 *
 * 注意**只有飘字用这个口径**：受击档位仍然拿各来源自己的量纲比 meta.damage 里的阈值
 * （见 damageLevel）——否则改一个显示换算就会把「多大的账算暴击」一起改掉。
 *
 * 想让 token 类来源更疼一点，只改下面这一个数（改成 10 就是 ×1000）。
 */
const TOKEN_BLOOD_PER_MILLION = 0.01

/** 一笔账掉多少血。 */
function bloodOf(amount, unit) {
  const v = Number(amount) || 0
  if (unit === 'CNY' || unit === 'credit') return v
  return v / 1e6 * TOKEN_BLOOD_PER_MILLION
}

/**
 * 「-」后面那半句：数值 + 小字单位。
 *   credit -> 0.09（积分）      WorkBuddy 的 credit 就是积分本身
 *   CNY    -> ¥0.004            DSH / 手动记账记的是人民币（= 余额口径）
 *   token  -> 0.0005（积分）     只报 token 的来源按 1 百万 = 0.01 折成血
 * 插件给了 `label`（如「未命中」）就接到单位后面 —— 一笔账拆成几条时靠它区分。
 */
function hitOf(amount, unit, label) {
  if (unit === 'CNY') return { hitValue: '¥' + fmtHit(amount), hitUnit: label || '' }
  const tail = label ? ' · ' + label : ''
  if (unit === 'credit') return { hitValue: fmtHit(amount), hitUnit: '积分' + tail }
  return { hitValue: fmtHit(bloodOf(amount, 'token')), hitUnit: '积分' + tail }
}

/* ---------- 速率：连击 ----------
 * 照 DSH 里那个 dsh-damage-pulse 插件的规则抄的：**两次「重击」（critical）间隔小于
 * 900ms 就算连击**（它的原话是 `now - lastCriticalAt < 900 ? 'critical-combo' : 'critical-pain'`）。
 * 连击不是新的档位，而是给渲染端的一个附加信号：动作照旧用最重那一档，
 * 但红闪和抖动要更狠一档 —— 桌面上的观感就是「连着被揍」。
 */
const COMBO_WINDOW_MS = 900
let lastCriticalAt = 0

/** 这笔账算不算连击（并更新「上一次重击」的时刻）。 */
function markCombo(at, level) {
  if (level !== 'critical') return false
  const ts = Number.isFinite(at) ? at : Date.now()
  const combo = lastCriticalAt > 0 && ts - lastCriticalAt < COMBO_WINDOW_MS
  lastCriticalAt = ts
  return combo
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
 * 插件还可以把一笔账**按费用构成拆成好几条**（DSH 就是这么干的：未命中 / 命中 /
 * 输出各一条，见 providers/dsh.js 的 costParts）—— 拆出来的那几条会各自带上
 * `label`（如「未命中」），排版成数字后面的小字，桌面上一眼能看出这笔钱花在哪儿。
 *
 * 唯一做的整理是补上缺省的 `unit`（没报量纲的按 token 算），别让渲染端拿到 undefined。
 */
function decorateEvents(events) {
  const out = []
  for (const ev of events) {
    const unit = ev.unit || 'token'
    out.push({ ...ev, unit, ...hitOf(ev.amount, unit, ev.label) })
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
/* 余额校准周期 = 60 秒。和 DSH 里那个 dsh-damage-pulse 一样：它 README 写「查询 DeepSeek
 * 官方余额并每 60 秒校准；扣费事件到达时先逐笔更新显示余额」。官方结算本身有延迟，
 * 查得再勤也只是拿到同一个数，60s 足够贴近官网，又不会白打接口。
 *
 * 两次校准之间余额**不是冻着的**：每读到一笔 DSH 扣费就先把显示值减掉（见
 * `balance.spentSince`），所以数字是「实时往下走、每 60s 回官方对齐一次」。 */
const BALANCE_INTERVAL_MS = 60 * 1000
const DSH_CREDENTIALS = path.join(os.homedir(), '.dsh', '.credentials.yaml')

const balance = {
  supported: !BALANCE_DISABLED,
  value: null,
  currency: 'CNY',
  available: null,
  fetchedAt: 0,
  // 自从上次校准以来、从账本里读到的 DSH 花费。显示值 = value - spentSince。
  // 只计 source === 'dsh' 且量纲是 CNY 的（DeepSeek 余额只被 DeepSeek 的花费扣）；
  // WorkBuddy 的 credit / 第三方 token 都不动这个数。
  spentSince: 0,
  error: '',
  inFlight: false,
}

/** 显示用的余额：官方校准值减去「校准之后实时读到的扣费」。 */
function liveBalance() {
  return liveBalanceOf(balance.value, balance.spentSince)
}

/** 这笔扣费要不要从 DeepSeek 余额里实时减掉。只有 DSH 的人民币花费算 ——
 *  WorkBuddy 的 credit、第三方 token 都不动 DeepSeek 的余额。 */
function countsTowardBalance(amount, unit, source) {
  return source === 'dsh' && unit === 'CNY' && Number(amount) > 0
}

/**
 * 显示值 = 官方校准值 − 自校准以来读到并已经扣掉的数。
 *
 * 为什么不是直接把 `value` 减下去：官方那个数每 60s 才拿一次，中间这段时间余额
 * 在桌面上必须是**动的**（否则一笔笔扣费飘过去了、数字却纹丝不动，看着像没生效）。
 * 下限夹到 0：官方偶发返回 0/欠费时不要显示负数。
 */
function liveBalanceOf(value, spentSince) {
  if (!Number.isFinite(value)) return null
  return Math.max(0, Number(value) - Number(spentSince || 0))
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
        // 校准之后重新开始逐笔累减：官方这个数是「截至它结算时刻」的，之后的扣费
        // 由账本实时补上。万一本地减多了或官方还没结算，下一次校准会把它拉回来。
        balance.spentSince = 0
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

  // 剩余积分：额度是用户填的快照（WorkBuddy 没有余额接口，见 readQuota 上的注释），
  // 累计 = 历史账本（截至昨天）+ 今天的实时值。没填额度就整段不加 —— 别显示一个
  // 「剩余 --」去勾着人填数。
  const remainLines = []
  let remainTag = ''
  if (config.quota && config.quota.credit > 0 && credits > 0) {
    const spent = creditSpentTotal(Object.keys(raw), credits)
    const remain = config.quota.credit - spent
    remainLines.push('WorkBuddy 剩余 ' + fmtAmount(Math.max(0, remain)) + ' / ' + fmtAmount(config.quota.credit)
      + ' 积分（额度 − 累计 ' + fmtAmount(spent) + '）')
    remainTag = ' · 余' + fmtAmount(Math.max(0, remain))
  }
  return [{
    id: 'today',
    label: '今日已用',
    value: parts.length ? parts.join(' · ') + remainTag : '--',
    tone: parts.length ? '' : 'off',
    title: parts.length
      ? '今日已用 ' + parts.join(' + ') + (remainLines.length ? '\n' + remainLines.join('\n') : '')
        + '\n按来源：\n' + lines.join('\n')
      : '今天还没有读到任何用量',
  }]
}

/** WorkBuddy 积分的**历史累计**：usage-history.json 里截至昨天的合计 + 今天的实时值。 */
function creditSpentTotal(sourceIds, todayCredit) {
  let total = 0
  try {
    const doc = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'))
    const today = bjDayKey(Date.now())
    for (const [day, e] of Object.entries(doc.days || {})) {
      if (day === today) continue // 今天的由实时值补足（历史 15 秒才落一次盘，且滞后一拍）
      const c = Number(e && e.workbuddy && e.workbuddy.credit) || 0
      total += c
    }
  } catch { /* 没有历史账本就只算今天 */ }
  return total + (Number(todayCredit) || 0)
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
    quota: { ...config.quota },
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
          // 档位：**插件自己给了就用它的**。DSH 那个插件是按「这笔钱花在哪儿」定档的
          // （未命中缓存=重 / 命中=中 / 输出=轻，照 dsh-damage-pulse 的口径），
          // 只有插件没说的才退回拿金额比 meta.damage 阈值。
          const level = TIERS.indexOf(ev.level) >= 0
            ? ev.level
            : damageLevel(ev.amount, def.meta.damage)
          // 字号的「大一号」只跟**金额**走（和档位解耦）：档位现在可能是「按种类」定的
          // （DSH 那笔未命中缓存只有 0.001 元却算重击），要是字号也跟着档位，
          // 桌面上就会出现「最小的数字字最大」。重击归动画，大小归钱。
          const crit = (def.meta.damage || []).find(t => t[1] === 'critical')
          // 余额实时：读到一笔 DSH 的花费就立刻从显示余额里减掉，不等下一次校准。
          // （账本里的 cost 就是这笔钱从余额里扣掉的数，量纲 CNY。）
          if (countsTowardBalance(ev.amount, ev.unit || def.meta.unit, ev.source || id)) {
            balance.spentSince += Number(ev.amount)
          }
          events.push({
            ...ev,
            source: ev.source || id,
            level,
            big: Number(ev.amount) >= (crit ? crit[0] : Infinity),
            combo: markCombo(ev.at || ts, level),   // 速率：短时间内连着挨重击 = 连击
          })
        })
      } catch { /* 单个插件崩了不影响桌宠 */ }
    }

    // 余额在后台异步查，不阻塞这一轮采集
    if (balance.supported && !balance.inFlight && ts - balance.fetchedAt > BALANCE_INTERVAL_MS) {
      refreshBalance()
    }
  }

  const ctx = { ctxLimit: CTX_LIMIT, fmtTokens, fmtAmount, balance: { ...balance, live: liveBalance() } }

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
        // 实时显示值（= 官方校准值 − 校准之后读到的扣费）。信息条上那一格用它，
        // 而 `value` 保留官方原值 —— 渲染端的「充值 → 复活」靠比较官方值判断，
        // 拿实时值去比会被自己的逐笔累减带偏（每笔扣费都像余额掉了，校准又像涨了）。
        live: liveBalance(),
        spentSince: balance.spentSince,
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
  bloodOf,
  TOKEN_BLOOD_PER_MILLION,
  COMBO_WINDOW_MS,
  markCombo,
  countsTowardBalance,
  liveBalanceOf,
  BALANCE_INTERVAL_MS,
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
  setQuota,
  reload,
}
