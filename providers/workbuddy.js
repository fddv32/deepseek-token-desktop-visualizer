// providers/workbuddy.js —— WorkBuddy（zcode 协议）用量
//
// 数据源：~/.workbuddy/logs/<日期>/<工作区>__<hash>.log
// 日志里有两类行：
//   [shouldCompact] Added trailing tool result tokens: +834, totalTokens=175474, isSubAgent=false, threshold=90.0%
//   [SessionManager][credit] Credit received: rootRequestId=01a0f1f..., source=raw_model_stream_event, credit=0.83
// 前者是当前会话的实时上下文 token；后者是**每次模型调用**的计费消耗。
// credit 是**增量**的：一次用户回合（同一个 rootRequestId）会陆续写几百条，
// 每条对应一次模型调用，必须**逐条累加** —— 见 poll() 里的 dedupKey。
//
// 为什么不读 ~/.workbuddy/projects/**/*.jsonl：里面只有 providerData.rawUsage 的
// token 数，**根本没有 credit**（在那儿能 grep 到的 "credit" 全是工具输出把日志正文
// 又写回 jsonl 的自引用）。所以这里只把它当备选，不采信。
//
// credit 有两个源，取长补短：
//   * 运行时日志（完整口径）：覆盖全部会话的每一笔调用，但**攒一批（约 512KB）
//     才落盘** —— 实测活跃时也要 1~5 分钟才看到新账，桌宠上就表现成
//     「钱都花完了，数字还不动」。
//   * workbuddy.db 的 session_usage.credit_json：{rootRequestId: 该回合累计}，
//     边跑边写（秒级），但**只有当前 session 的行** —— 别的会话、别的调用方看不到。
// 于是两边各记一份账、按 rootRequestId 对齐、取较大值：db 领先时先把数字抬上去，
// 日志补到同一终值也不会重复计。见 poll() 里的 ledger。
//
// 读 db 的障碍：Electron 33 内置 Node 20 没有 node:sqlite（要 22.5+），WorkBuddy
// 自带的 better-sqlite3 又是按别的 ABI 编的。所以借 api.sqliteQuery —— 它会去起
// WorkBuddy 自己那个 Node 22 的子进程。借不到就静默退回日志源，功能不受影响。
//
// 「缓存未命中」是第三个源：~/.workbuddy/projects/<工作区>/<会话>.jsonl 里每条模型
// 调用的 providerData.rawUsage。上面两个源都没有这个字段 —— 日志里只有 shouldCompact
// 和 credit —— 所以只能另起一路，见 scanTodayTail()。
'use strict'

const meta = {
  id: 'workbuddy',
  label: 'WorkBuddy',
  vendor: '腾讯 WorkBuddy / zcode 协议',
  badge: 'WB',
  builtin: true,
  // WorkBuddy 计的是 credit，桌面上按「积分」显示（用户口径）。其余来源都是 token。
  unit: 'credit',
  paths: ['~/.workbuddy/logs', '~/.workbuddy/projects'],
  desc: '读运行时日志：上下文 token（shouldCompact）与每次调用的 credit；缓存命中读会话 jsonl',
  fields: [
    { id: 'ctx', label: '上下文', desc: '本轮会话的实时上下文 token 占用' },
    { id: 'workbuddy', label: 'WB 今日', unit: 'credit', desc: 'WorkBuddy 今日消耗的积分' },
    { id: 'wbcache', label: '缓存未命中', desc: '今日所有调用里 prompt 缓存未命中的占比，越低越省（命中部分按缓存价计）' },
  ],
  // 阈值按**单条 credit** 定（每条 = 一次模型调用）。实测单条中位数 0.09、均值 0.11、
  // 最大 1.7，所以 0.5 / 0.1 大致对应「1% 暴击、四成普通痛」—— 一次落盘的一批
  // （几十条）里总能挑出最重的那笔来播，不至于永远只抖最轻的一档。
  // 早先写的是 [[3, 'critical'], [1, 'normal']]，那是按「一次用户回合的总花费」
  // 估的 —— 单条永远够不着 1，阈值从没生效过。
  // 单位就是这个来源自己的量纲（credit = 积分），浮点上飘的也是同一个数。
  damage: [[0.5, 'critical'], [0.1, 'normal']],
}

// 日志正文里换行是 \n；行首锚定可以避开「工具输出把日志内容又打进日志」的自引用污染。
const RE_CTX = /^\[\d{4}\/\d{1,2}\/\d{1,2} [\d:.]+\] \[[^\]]+\] \[pid=\d+\] \[shouldCompact\] Added trailing tool result tokens: \+\d+, totalTokens=(\d+), isSubAgent=(true|false)/
const RE_CREDIT = /^\[\d{4}\/\d{1,2}\/\d{1,2} [\d:.]+\] \[[^\]]+\] \[pid=\d+\] \[SessionManager\]\[credit\] Credit received: rootRequestId=([0-9a-f]+), source=([A-Za-z_]+), credit=([\d.]+)/
const RE_LOG_TS = /^\[(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{2}):(\d{2})\.(\d{3})\]/
const BJ_OFFSET_MS = 8 * 60 * 60 * 1000

/* ---------- 缓存命中（projects/<工作区>/<会话>.jsonl） ----------
 * 每条模型调用是一条 JSONL 记录，providerData.rawUsage 里有：
 *   "prompt_cache_hit_tokens":35200,"prompt_cache_miss_tokens":415
 * 未命中率 = miss / (hit + miss)。
 *
 * 取数的两个坑，都是实测出来的：
 *  1. 记录行以 {"id":"…","parentId":…,"timestamp":… 开头，所以**锚在行首**取时间戳。
 *     整行匹配 "timestamp": 是不行的 —— 工具输出会把别的地方的 JSON 回显进同一行。
 *  2. 缓存字段全部落在 rawUsage 开头 1.2KB 内（实测 1568 行无一例外，且与
 *     JSON.parse 出来的真值逐条一致）。所以不必 JSON.parse 整行 —— 那要解析上百 KB
 *     的正文，纯浪费。
 */
const RE_REC_TS = /^\{"id":"[0-9a-fA-F-]+","parentId":[^,]+,"timestamp":(\d{13})/
const MARK_USAGE = '"rawUsage":{"prompt_tokens":'
const RE_CACHE_HIT = /"prompt_cache_hit_tokens":(\d+)/
const RE_CACHE_MISS = /"prompt_cache_miss_tokens":(\d+)/
const USAGE_WINDOW = 1200

// 回扫的块大小与上限。块大一点 syscall 少，上限纯粹是防呆 —— 真撞上说明文件里
// 今天的记录超过 96MB，那时候读全天的量本来就是必要的。
const SCAN_CHUNK = 1 << 20
const SCAN_MAX = 96 << 20
// 只认最近动过的会话文件：今天的记录不可能出现在一个 36 小时没写过的文件里。
const PROJECTS_SINCE_MS = 36 * 60 * 60 * 1000
// 重扫目录的间隔。readdir 是每个工作区一次，工作区攒多了就不该跟着 2.5s 的轮询走；
// 缓存是个「今日合计」，晚十几秒发现新会话完全看不出来。
const PROJECTS_RESCAN_MS = 15 * 1000
const PROJECTS_MAX_FILES = 60

/* ---------- 实时源（workbuddy.db） ---------- */

// credit_json 是 {rootRequestId: 该回合累计积分}
const LIVE_SQL = 'select session_id, credit_json from session_usage'
// 多久问一次 db。每问一次都要起一个 Node 子进程（约 60~100ms CPU），所以别贴着
// 宿主 2.5s 的轮询走 —— 5 秒对「看着数字往上爬」已经完全够用（日志那边可是分钟级）。
const LIVE_INTERVAL_MS = 5000
// 连续失败几次就彻底放弃实时源，别每轮白起进程
const LIVE_MAX_FAILS = 3

/**
 * UUIDv7 的前 12 位 hex 就是毫秒时间戳 —— WorkBuddy 的 rootRequestId 正是 v7，
 * 于是不用额外查表就能知道「这个回合是什么时候开始的」，据此按天归类。
 * db 里混着少量非 v7 的 id（别的调用方），那时把前 12 位当时间戳会算出天外飞仙的
 * 年份，所以做一次合理性检查：不认识的返回 0，调用方改用当前时间兜底。
 */
function uuid7Time(id) {
  if (typeof id !== 'string' || id.length < 12) return 0
  const hex = id.replace(/-/g, '').slice(0, 12)
  if (!/^[0-9a-fA-F]{12}$/.test(hex)) return 0
  const ms = parseInt(hex, 16)
  return ms > 1420070400000 && ms < 4102444800000 ? ms : 0 // 2015 ~ 2100
}

function create(api) {
  const { fs, path, bjDayKey, num } = api
  const ROOT = api.expand('~/.workbuddy/logs')
  const DB_FILE = api.expand('~/.workbuddy/workbuddy.db')
  const PROJECTS_ROOT = api.expand('~/.workbuddy/projects')

  const state = {
    files: new Map(), // file -> Tailer
    ctxTokens: 0,
    ctxAt: 0,
    ctxModel: '',
    dayKey: 0,
    todayCredit: 0, // 派生值：每轮 poll 由账本重算，见 sumToday()
    callsToday: 0,
    totalCredit: 0,
    // 账本：rootRequestId -> { startDay, loggedToday, live, liveBase }
    //   startDay    —— 回合开始那天（首次见到时定下，之后不再改）
    //   loggedToday —— 日志里落在**今天**的那些行累加出来的金额（精确到行，但慢）
    //   live        —— db 里该回合的累计额（快，但只有当前 session，且拆不开日期）
    //   liveBase    —— 首次从 db 见到它时的值，-1 表示还没见过；横跨午夜的回合
    //                  只认「live - liveBase」这部分增量
    // 今日贡献见 contrib()
    byId: new Map(),
    seen: new Set(), // 已计入的账目（dedupKey），跨天清空
    lastCallAt: 0,
    lastModel: '',
    updatedAt: 0,
    available: false,
    logFiles: 0, // 本轮扫到的日志文件数。credit 那两项的「有没有数据」看它
    detail: '未找到日志目录',
    live: {
      ok: null, // null=还没结论 / true=能用 / false=已放弃
      fails: 0,
      pending: false,
      nextAt: 0,
      at: 0,
      armed: false, // 首次快照只建基线，不放动画
    },
    // 缓存命中：每个会话文件一份子账，今日合计**求和**得出 —— 和上面的 credit 账本
    // 同一个思路，文件被截断时只重置它自己那一份，合计不会算重。
    cache: {
      files: new Map(), // file -> { tailer, scanned, hit, miss, calls, lastAt, lastHit, lastMiss }
      dayKey: 0,
      list: [],
      nextListAt: 0,
    },
  }

  // 宿主每轮 poll 才把 emit 递进来，而实时源是异步回调 —— 所以存一份在闭包里
  let emitTo = null

  /**
   * 取（必要时新建）某个回合的账目。
   * startDay = 回合开始那天，只在首次见到时定下 —— 日志用行的行首时间戳，
   * db 用 UUIDv7 里的起始毫秒，两边同一把尺子。
   */
  function ledgerOf(id, at) {
    let e = state.byId.get(id)
    if (!e) {
      e = { startDay: bjDayKey(at), loggedToday: 0, live: 0, liveBase: -1 }
      state.byId.set(id, e)
    }
    return e
  }

  /**
   * 这个回合给「今天」贡献多少。
   *
   * 日志那半是按**行的日期**算的，精确到行；db 那半只有一个回合的总额、根本拆不开，
   * 所以分两种情况：
   *   * 回合今天才开始 —— db 那个数本来就全属于今天，直接和日志取较大值；
   *   * 回合开始于更早（横跨午夜）—— db 值里混着昨天的钱，只认「比基线涨了多少」，
   *     而基线会在跨天那一刻被推到当时的值（见 poll 里的跨天分支），所以午夜之后
   *     的增长一样能秒级看到。
   */
  function contrib(e, day) {
    if (e.startDay === day) return Math.max(e.loggedToday, e.live)
    const grew = e.liveBase < 0 ? 0 : e.live - e.liveBase
    return Math.max(e.loggedToday, grew > 0 ? grew : 0)
  }

  /**
   * 记一笔账，返回「这次让该回合的今日贡献涨了多少」—— 只有涨了才该播受击动画。
   * 日志和 db 都走这里：取的是 max，谁先到都只涨一次，不会重复放。
   */
  function bump(e, day, logged, live) {
    const before = contrib(e, day)
    if (logged > 0) e.loggedToday += logged
    if (live > e.live) e.live = live
    return contrib(e, day) - before
  }

  /** 今日合计：把每个回合的今日贡献加起来。 */
  function sumToday() {
    const day = state.dayKey
    let s = 0
    for (const e of state.byId.values()) s += contrib(e, day)
    return s
  }

  /* ---------- 实时源 ---------- */

  /**
   * 问一次 workbuddy.db。异步的 —— 子进程启动要几十毫秒，同步等会卡住主进程。
   * 这一轮拿不到就下一轮再问，账本里已有的数字不会因此回退。
   */
  function tickLive(now) {
    const L = state.live
    if (L.ok === false || L.pending || now < L.nextAt) return
    L.nextAt = now + LIVE_INTERVAL_MS
    L.pending = true
    api.sqliteQuery(DB_FILE, LIVE_SQL).then(rows => {
      L.pending = false
      if (!rows) {
        L.fails += 1
        if (L.fails >= LIVE_MAX_FAILS) L.ok = false // 本机读不了，安静退回日志源
        return
      }
      L.fails = 0
      L.ok = true
      L.at = Date.now()
      applyLive(rows, L.at)
    }).catch(() => {
      L.pending = false
    })
  }

  /** 把 db 的快照并进账本：同一个 rootRequestId 取较大值。 */
  function applyLive(rows, at) {
    for (const r of rows) {
      let cj
      try {
        cj = JSON.parse(r.credit_json || '{}')
      } catch {
        continue
      }
      for (const id of Object.keys(cj)) {
        const v = num(cj[id])
        if (v <= 0) continue
        // 归日靠 UUIDv7 的起始时间戳；不是 v7 的 id 没法判断属于哪一天 ——
        // 这种「只有 db 有、日志还没登记过」的账宁可不记（记了会把昨天的钱算到今天），
        // 但日志登记过的（说明它确实是今天的回合）照样用它补足。
        let e = state.byId.get(id)
        if (!e) {
          const ms = uuid7Time(id)
          if (!ms) continue
          e = ledgerOf(id, ms)
        }
        // 首次见到这个回合就把它当时的值记成基线：横跨午夜的回合之后只算增量，
        // 不会把昨天那部分也当今天的钱。
        if (e.liveBase < 0) e.liveBase = v
        const grew = bump(e, state.dayKey, 0, v)
        if (grew > 0 && state.live.armed && emitTo) {
          emitTo({ source: 'workbuddy', amount: grew, unit: 'credit', at, id: id + '@live' })
        }
      }
    }
    state.live.armed = true
  }

  /** 日志行首的时间戳是本地（北京时间），转成 UTC 毫秒。 */
  function parseLogTs(line) {
    const m = RE_LOG_TS.exec(line)
    if (!m) return 0
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]) - BJ_OFFSET_MS
  }

  /** UTC 毫秒 → 北京时间的 HH:MM:SS。用来在悬停里标注「数字已经算到哪一刻」。 */
  function bjClock(ts) {
    if (!ts) return ''
    const d = new Date(ts + BJ_OFFSET_MS)
    const p = n => String(n).padStart(2, '0')
    return p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds())
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

  /* ---------- 缓存命中：projects/*.jsonl ---------- */

  /** 把一条记录行里的缓存 token 记进这个文件的子账。不是模型调用行就直接跳过。 */
  function noteUsage(entry, line, at) {
    const i = line.indexOf(MARK_USAGE)
    if (i < 0) return
    const seg = line.slice(i, i + USAGE_WINDOW)
    const h = RE_CACHE_HIT.exec(seg)
    const m = RE_CACHE_MISS.exec(seg)
    if (!h || !m) return
    const hit = num(h[1])
    const miss = num(m[1])
    if (hit + miss <= 0) return
    entry.hit += hit
    entry.miss += miss
    entry.calls += 1
    // 最后一条按时间比，不是按读取顺序 —— 回扫是从后往前读的
    if (at >= entry.lastAt) {
      entry.lastAt = at
      entry.lastHit = hit
      entry.lastMiss = miss
    }
  }

  /**
   * 首次接入某个会话文件时，从**文件尾部**往回扫，只收今天的记录。
   *
   * 为什么不整份读：单个会话文件实测能到 65MB，而今天新增的往往只有十几 MB ——
   * 整份读一次要几百毫秒，主进程会被卡住（桌宠的定时器、拖动都跟着顿）。
   * jsonl 是按时间追加的，今天的记录必然在末尾，所以从尾部按块回读，
   * **读到一条更早的记录就停**，读到的量正好等于今天那一段。
   *
   * @returns {number} 扫完之后 Tailer 该从哪个字节继续。
   *   末尾若压着一条正在写入的半行，会退到它之前 —— 半行现在算不准，也不能让
   *   Tailer 从行中间接起。出错时一律返回文件末尾：宁可不补今天的存量，
   *   也不要退化成「每轮重读整个文件」。
   */
  function scanTodayTail(file, day, entry) {
    let fd = -1
    let size = 0
    try {
      fd = fs.openSync(file, 'r')
      size = fs.fstatSync(fd).size
    } catch {
      if (fd >= 0) { try { fs.closeSync(fd) } catch { /* 已关 */ } }
      return 0
    }
    if (size === 0) {
      try { fs.closeSync(fd) } catch { /* 已关 */ }
      return 0
    }
    try {
      // 末尾没有换行 => 最后一行还在写。退到最后一个换行之后。
      let end = size
      const probeLen = Math.min(size, 4096)
      const probe = Buffer.allocUnsafe(probeLen)
      const got = fs.readSync(fd, probe, 0, probeLen, size - probeLen)
      if (got > 0 && probe[got - 1] !== 0x0a) {
        const nl = probe.lastIndexOf(0x0a, got - 1)
        end = nl >= 0 ? (size - probeLen + nl + 1) : 0
      }

      let cursor = end
      let scanned = 0
      let carry = '' // 更靠后的那块被切断的「行尾」，拼回本块才凑得成完整行
      while (cursor > 0 && scanned < SCAN_MAX) {
        const start = Math.max(0, cursor - SCAN_CHUNK)
        const len = cursor - start
        const buf = Buffer.allocUnsafe(len)
        const n = fs.readSync(fd, buf, 0, len, start)
        if (n <= 0) break
        scanned += n

        const parts = (buf.toString('utf8', 0, n) + carry).split('\n')
        // start > 0 时首个元素是某行的后半截，攒给下一块；否则它就是文件第一行。
        carry = start > 0 ? (parts.shift() || '') : ''

        let older = false
        for (const line of parts) {
          const ts = RE_REC_TS.exec(line)
          if (!ts) continue
          const at = Number(ts[1])
          if (bjDayKey(at) !== day) { older = true; continue }
          noteUsage(entry, line, at)
        }
        if (older) break // 记录按时间追加，第一条更早的后面就不可能有今天的了
        cursor = start
      }
      return end
    } catch {
      return size
    } finally {
      try { fs.closeSync(fd) } catch { /* 已关 */ }
    }
  }

  /** 最近写过的会话 jsonl。今天的记录只会落在这些文件里。 */
  function listProjects(now) {
    const C = state.cache
    if (now < C.nextListAt) return C.list
    C.nextListAt = now + PROJECTS_RESCAN_MS
    C.list = api.walkFiles(PROJECTS_ROOT, {
      name: /\.jsonl$/,
      sinceMs: PROJECTS_SINCE_MS,
      maxFiles: PROJECTS_MAX_FILES,
      maxDepth: 4,
    }).map(x => x.file)
    return C.list
  }

  /** 今日合计：把各文件的子账加起来（不是累加值，所以重复读也不会算重）。 */
  function cacheTotals() {
    const t = { hit: 0, miss: 0, calls: 0, lastAt: 0, lastHit: 0, lastMiss: 0 }
    for (const e of state.cache.files.values()) {
      t.hit += e.hit
      t.miss += e.miss
      t.calls += e.calls
      if (e.lastAt > t.lastAt) {
        t.lastAt = e.lastAt
        t.lastHit = e.lastHit
        t.lastMiss = e.lastMiss
      }
    }
    return t
  }

  /**
   * 采一轮缓存命中。首次见到某个文件时回扫一次「今天」那一段，之后用 Tailer 增量跟。
   * 自己记日期：上面 credit 那套账的 dayKey 在日志目录为空时根本不会推进，
   * 两个源各有各的跨天点，不该互相牵连。
   */
  function pollCache(now) {
    const C = state.cache
    const day = bjDayKey(now)
    if (C.dayKey !== day) {
      C.dayKey = day
      // Tailer 的 offset 不动：文件里已经读过的部分不用再看，新的记录本来就属于今天
      for (const e of C.files.values()) {
        e.hit = 0; e.miss = 0; e.calls = 0; e.lastAt = 0; e.lastHit = 0; e.lastMiss = 0
      }
    }

    const files = listProjects(now)
    for (const file of files) {
      let e = C.files.get(file)
      if (!e) {
        e = {
          tailer: new api.Tailer(file), scanned: false,
          hit: 0, miss: 0, calls: 0, lastAt: 0, lastHit: 0, lastMiss: 0,
        }
        C.files.set(file, e)
      }

      // 文件被截断/重建（大小退回）—— 之前读的全作废，重新回扫，免得把旧账
      // 一直算在今天头上。会话 jsonl 正常只追加，这条是防呆。
      let size = 0
      try { size = fs.statSync(file).size } catch { size = 0 }
      if (size < e.tailer.offset) {
        e.hit = 0; e.miss = 0; e.calls = 0; e.lastAt = 0
        e.tailer.offset = 0
        e.tailer.carry = ''
        e.scanned = false
      }

      if (!e.scanned) {
        e.tailer.offset = scanTodayTail(file, day, e)
        e.tailer.carry = ''
        e.scanned = true
      }

      for (const line of e.tailer.drain()) {
        const ts = RE_REC_TS.exec(line)
        if (!ts) continue
        const at = Number(ts[1])
        if (bjDayKey(at) !== day) continue
        noteUsage(e, line, at)
      }
    }

    // 太久没动、已经不在列表里的文件丢掉。能进列表的文件只要今天写过就一定带今天的
    // 记录，所以被丢掉的这些本来也没贡献，合计不会因此掉下来。
    for (const key of [...C.files.keys()]) {
      if (!files.includes(key)) C.files.delete(key)
    }
  }

  function poll(now, emit) {
    emitTo = emit // 实时源是异步回调，隔了几轮才回来，也得能放动画
    const files = listLogs()
    state.logFiles = files.length
    state.available = files.length > 0
    if (!state.available) {
      state.detail = fs.existsSync(ROOT) ? '日志目录为空（今天还没用过？）' : '未找到 ~/.workbuddy/logs'
    }

    // 缓存命中是另一个源，日志目录读不到时它照样可能有数 —— 所以放在 return 之前
    pollCache(now)
    if (cacheTotals().calls > 0) state.available = true
    if (files.length === 0) return

    // 清掉已经不在列表里的 tailer，避免 Map 无限增长
    for (const key of [...state.files.keys()]) {
      if (!files.includes(key)) state.files.delete(key)
    }

    const day = bjDayKey(now)
    if (day !== state.dayKey) {
      const prevDay = state.dayKey
      state.dayKey = day
      state.callsToday = 0
      state.seen.clear()
      // 跨天：今天的计数归零，并把 db 基线推到此刻 —— 这样横跨午夜的回合里，
      // 只有午夜之后的增长才算今天的钱。早于昨天的回合整本丢掉，别白占内存。
      for (const [id, e] of state.byId) {
        if (e.startDay < prevDay) {
          state.byId.delete(id)
          continue
        }
        e.loggedToday = 0
        if (e.liveBase >= 0) e.liveBase = e.live
      }
    }

    // 顺手问一次实时源：异步，这一轮拿不到就下一轮用
    tickLive(now)

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

        const credit = num(rawCredit)
        if (credit <= 0) continue

        const at = parseLogTs(line) || now
        // 去重键**不能只用 requestId**。同一个 rootRequestId（一次用户回合）会陆续
        // 写几百条 credit，每条都是一次模型调用的结算 —— 按 requestId 去重等于一次
        // 回合只算下第一条：实测某天 1062 条 / 120.76 积分被压成 13 条 / 9.03，
        // 表现就是「桌宠上的积分几乎不涨、也跟不上正在花的钱」。
        // 改用「时间戳 + 请求 id + 金额」当键：既能逐条计入，又能在日志轮转
        // （同一行同时存在于 xxx.log 和 xxx.old.log）时认出是同一笔、不重复计。
        const dedupKey = at + '|' + requestId + '|' + rawCredit
        if (state.seen.has(dedupKey)) continue
        state.seen.add(dedupKey)

        // 计进账本。先建账（哪怕这行是昨天的尾巴，也要先记下回合的开始日），
        // 再判断这行落不落在今天 —— 昨天收尾时写进今天文件的尾巴钱不能算今天。
        const e = ledgerOf(requestId, at)
        if (bjDayKey(at) !== day) continue
        const grew = bump(e, day, credit, 0)

        state.totalCredit += credit
        state.callsToday += 1
        state.lastCallAt = at
        state.updatedAt = at

        // 只有账本真的涨了才放动画：同一笔如果已被实时源抢先记过，这里就是 0
        if (grew > 0 && tailer.armed) {
          emit({ source: 'workbuddy', amount: grew, unit: 'credit', at, id: requestId + '@' + at })
        }
      }
      tailer.armed = true
    }

    // 一天几千条账目，正常清不完；真攒到这个量说明用了很久没跨天，留最近的一批就够。
    if (state.seen.size > 60000) state.seen = new Set([...state.seen].slice(-10000))

    // 今日合计由账本重算 —— 不是累加值，所以实时源和日志谁补上都不会算重
    state.todayCredit = sumToday()

    // detail 放在采集之后写：计数值这一轮才更新，写在前面会慢一拍
    state.detail = files.length + ' 个活动日志 · 今日 ' + state.callsToday + ' 次'
      + (state.live.ok ? ' · 实时' : '')
      + (cacheTotals().calls ? ' · 缓存 ' + cacheTotals().calls + ' 条' : '')
  }

  return {
    get available() { return state.available },
    get detail() { return state.detail },
    poll,
    raw(now) {
      const ct = cacheTotals()
      return {
        available: state.available,
        ctxTokens: state.ctxTokens,
        ctxAt: state.ctxAt,
        todayCredit: state.todayCredit,
        callsToday: state.callsToday,
        totalCredit: state.totalCredit,
        lastCallAt: state.lastCallAt,
        lastModel: state.lastModel,
        live: state.live.ok === true, // 数字是不是秒级的
        liveAt: state.live.at,
        active: now - state.updatedAt < 90 * 1000,
        // 缓存命中（今日）
        cacheHitTokens: ct.hit,
        cacheMissTokens: ct.miss,
        cacheCalls: ct.calls,
        cacheLastAt: ct.lastAt,
        cacheLastHit: ct.lastHit,
        cacheLastMiss: ct.lastMiss,
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
      // credit 那一项的「有没有数据」看日志文件数，不看 state.available ——
      // 后者现在还包含缓存源，两边混用会让「没有 credit 数据」被显示成「0.00 积分」。
      const creditOn = state.logFiles > 0
      out.push({
        id: 'workbuddy',
        label: 'WB 今日',
        // 有数据就显示「5.47 积分」；没有数据时连单位一起收起来，别变成刺眼的「-- 积分」
        value: creditOn ? ctx.fmtAmount(state.todayCredit) : '--',
        unit: creditOn ? '积分' : '',
        tone: creditOn ? '' : 'off',
        title: creditOn
          ? 'WorkBuddy 今日消耗 ' + ctx.fmtAmount(state.todayCredit) + ' 积分 · ' + state.callsToday + ' 次调用\n'
            + '  数据来自 ' + (state.live.ok ? 'workbuddy.db（秒级）' : '运行日志（攒一批才落盘，会慢几分钟）')
            + (state.lastCallAt ? '，最后一笔 ' + bjClock(state.lastCallAt) : '')
          : '未找到 WorkBuddy 日志',
      })

      // 缓存未命中：只统计 prompt 部分。新开一轮对话时命中率天然很差（没有前缀可复用），
      // 所以阈值定得比「单次」宽 —— 这是**今日合计**，一整天下来正常在个位数百分比。
      const ct = cacheTotals()
      const cacheTotal = ct.hit + ct.miss
      if (cacheTotal > 0) {
        const pct = ct.miss / cacheTotal * 100
        const lastTotal = ct.lastHit + ct.lastMiss
        const lines = [
          'prompt 缓存未命中 ' + pct.toFixed(1) + '%（今日 ' + ct.calls + ' 次调用）',
          '  命中 ' + ctx.fmtTokens(ct.hit) + ' token · 未命中 ' + ctx.fmtTokens(ct.miss) + ' token',
        ]
        if (ct.lastAt) {
          lines.push('  最近一次 ' + (lastTotal > 0 ? (ct.lastMiss / lastTotal * 100).toFixed(1) + '%' : '--')
            + '（' + bjClock(ct.lastAt) + '）')
        }
        lines.push('  越低越省：命中的那部分按缓存价计费')
        out.push({
          id: 'wbcache',
          label: '缓存未命中',
          value: pct.toFixed(1) + '%',
          tone: pct >= 50 ? 'danger' : (pct >= 25 ? 'warn' : ''),
          title: lines.join('\n'),
        })
      } else {
        out.push({
          id: 'wbcache',
          label: '缓存未命中',
          value: '--',
          tone: 'off',
          title: '今天还没读到带缓存字段的调用记录\n数据来自 ~/.workbuddy/projects 下的会话 jsonl',
        })
      }
      return out
    },
  }
}

module.exports = { meta, create }
