// providers/api.js —— 宿主注入给每个用量插件的小工具集
//
// 插件（providers/*.js 或 ~/.whalepet/providers/*.js）只拿到这些，不直接 require
// 任何东西，这样：
//   * 第三方插件不需要猜 Electron 的模块解析路径；
//   * 以后想换实现（比如把 Tailer 换成读 SQLite）只改这一处。
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const HOME = os.homedir()
const BJ_OFFSET_MS = 8 * 60 * 60 * 1000

/* ---------- 北京时间 ---------- */

function bjParts(ts) {
  const d = new Date(ts + BJ_OFFSET_MS)
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    hh: d.getUTCHours(),
    mm: d.getUTCMinutes(),
    dow: d.getUTCDay(), // 0=周日
  }
}

function bjDayKey(ts) {
  const p = bjParts(ts)
  return p.y * 10000 + p.m * 100 + p.d
}

/** 今天 00:00（北京时间）对应的 UTC 毫秒。日志筛选用。 */
function bjTodayStart(ts) {
  const p = bjParts(ts)
  return Date.UTC(p.y, p.m - 1, p.d, 0, 0, 0, 0) - BJ_OFFSET_MS
}

/* ---------- 增量读取器 ---------- */

/**
 * 只读追加内容。offset 按文件路径记住；文件被截断/轮转（变小）时自动从头再来。
 *
 * 必须循环读到没有剩余字节为止：readSync 单次不保证读满（实测 3MB 会话日志
 * 一次只拿回一部分），而 offset 一旦推到 stat.size，没读到的部分就永久丢了。
 */
class Tailer {
  constructor(file) {
    this.file = file
    this.offset = 0
    this.carry = '' // 上一轮读到的半行
  }

  /** 返回新出现的完整行数组；读不到就返回空数组。 */
  drain() {
    let stat
    try {
      stat = fs.statSync(this.file)
    } catch {
      return []
    }
    if (!stat.isFile()) return []
    if (stat.size < this.offset) {
      this.offset = 0
      this.carry = ''
    }
    if (stat.size === this.offset) return []

    const chunks = []
    let pos = this.offset
    let fd = -1
    try {
      fd = fs.openSync(this.file, 'r')
      let remaining = stat.size - pos
      while (remaining > 0) {
        const want = Math.min(remaining, 1 << 20)
        const buf = Buffer.allocUnsafe(want)
        const got = fs.readSync(fd, buf, 0, want, pos)
        if (got <= 0) break
        chunks.push(got === want ? buf : buf.subarray(0, got))
        pos += got
        remaining -= got
      }
    } catch {
      return []
    } finally {
      if (fd >= 0) {
        try { fs.closeSync(fd) } catch { /* 已关闭 */ }
      }
    }
    // 只推进到真正读到的位置：中途失败的话下次还能补上
    this.offset = pos

    const text = this.carry + Buffer.concat(chunks).toString('utf8')
    const parts = text.split('\n')
    this.carry = parts.pop() || ''
    // 单行异常长（工具输出被写进日志）时丢掉尾巴，避免内存里留个巨型字符串
    if (this.carry.length > 1 << 20) this.carry = ''
    return parts
  }
}

/**
 * 一批文件的增量读取器。
 *
 * 每个「扫一批日志文件」的插件都要写同一套东西：tailers Map、清理已经不在列表里的
 * 文件、以及「首轮读到的历史只累计不发事件」的 armed 开关。手写三遍就会漏一遍，
 * 漏了的表现是桌宠一启动就为历史账放一串受击动画。统一实现一次。
 *
 *   const tails = new api.TailSet()
 *   for (const { line, history } of tails.read(files)) {
 *     …
 *     if (!history) emit({ … })
 *   }
 */
class TailSet {
  constructor() {
    this.map = new Map()
  }

  /**
   * 增量读一批文件。
   * @param {string[]} files 本轮要读的文件（绝对路径）
   * @returns {Generator<{line: string, history: boolean, file: string, tailer: Tailer}>}
   *   history=true 表示这一行来自该文件的**首轮**读取，即历史账，调用方应当只累计。
   */
  *read(files) {
    const alive = new Set(files)
    for (const key of [...this.map.keys()]) {
      if (!alive.has(key)) this.map.delete(key) // 文件被轮转/删除，别让 Map 无限涨
    }
    for (const file of files) {
      let entry = this.map.get(file)
      if (!entry) {
        const tailer = new Tailer(file)
        tailer.offset = 0 // 从头上读：一启动就要能算出「今日合计」
        entry = { tailer, first: true }
        this.map.set(file, entry)
      }
      const lines = entry.tailer.drain()
      const history = entry.first
      entry.first = false
      if (lines.length) for (const line of lines) yield { line, history, file, tailer: entry.tailer }
    }
  }

  get size() {
    return this.map.size
  }
}

/**
 * 跨天重置。
 *
 * 北京时间跨过 00:00 时把当日累计清零 —— 每个插件都要做，而且都要顺手清掉
 * 去重集合（昨天的 id 不该挡住今天的同名记录）。
 *
 *   const day = api.rollDay(now, state, () => { state.today = blank(); state.seen.clear() })
 *   if (api.bjDayKey(at) !== day) continue
 */
function rollDay(now, state, onNewDay) {
  const day = bjDayKey(now)
  if (day !== state.dayKey) {
    state.dayKey = day
    onNewDay()
  }
  return day
}

/* ---------- 目录扫描 ---------- */

/**
 * 递归找文件。比每次 glob 便宜，而且能顺手按 mtime 过滤 ——
 * 用量日志动辄几十 MB、上千个文件，必须只碰「最近还在写」的那些。
 *
 * @param {string} root         起始目录
 * @param {object} opt
 * @param {RegExp} opt.name     文件名正则
 * @param {number} opt.sinceMs  只保留 mtime 晚于 (Date.now()-sinceMs) 的文件
 * @param {number} opt.maxFiles 上限，防御性截断
 * @param {number} opt.maxDepth 目录深度上限
 */
function walkFiles(root, opt = {}) {
  const name = opt.name || /.*/
  const since = Number(opt.sinceMs) > 0 ? Date.now() - opt.sinceMs : 0
  const maxFiles = Number(opt.maxFiles) > 0 ? opt.maxFiles : 400
  const maxDepth = Number(opt.maxDepth) > 0 ? opt.maxDepth : 8
  const out = []

  const stack = [{ dir: root, depth: 0 }]
  while (stack.length) {
    const { dir, depth } = stack.pop()
    if (depth > maxDepth) continue
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        stack.push({ dir: full, depth: depth + 1 })
        continue
      }
      if (!ent.isFile() || !name.test(ent.name)) continue
      let st
      try {
        st = fs.statSync(full)
      } catch {
        continue
      }
      if (since && st.mtimeMs < since) continue
      out.push({ file: full, size: st.size, mtimeMs: st.mtimeMs })
      if (out.length >= maxFiles) return out
    }
  }
  out.sort((a, b) => a.mtimeMs - b.mtimeMs)
  return out
}

/** 从 ~/... 形式展开到绝对路径，顺便做存在性判断，插件里不用自己拼 home。 */
function expand(p) {
  if (!p) return ''
  if (p === '~') return HOME
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(HOME, p.slice(2))
  return p
}

/* ---------- 数值 ---------- */

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** ISO-8601（带 Z 或 +08:00）转 UTC 毫秒；不合法返回 0。 */
function parseIso(s) {
  if (!s) return 0
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : 0
}

/** 单位显示名。插件在 fields() 里写 `unit: 'token'`，渲染端就据此加个小字后缀。 */
const UNIT_LABEL = { token: 'token', credit: '积分', CNY: '元' }

/** 把一个插件字段的 value + unit 拼成显示串（不想自己拼的时候用）。 */
function withUnit(value, unit) {
  const label = UNIT_LABEL[unit] || unit || ''
  return label ? value + ' ' + label : String(value)
}

module.exports = {
  fs,
  os,
  path,
  HOME,
  bjParts,
  bjDayKey,
  bjTodayStart,
  parseIso,
  num,
  expand,
  walkFiles,
  Tailer,
  TailSet,
  rollDay,
  UNIT_LABEL,
  withUnit,
}
