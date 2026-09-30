// providers/claude.js —— Claude Code
//
// 数据源：~/.claude/projects/<项目目录>/<session>.jsonl
// 每行一条消息，assistant 行带 usage：
//   { "type": "assistant", "timestamp": "2026-09-22T09:36:37.575Z",
//     "message": { "model": "claude-...", "usage": {
//        input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens } } }
//
// 两个坑：
//   1. 有 message.model === "<synthetic>" 的本地合成行，usage 全是 0，必须跳过，
//      否则「今日调用次数」会被这些空行灌水。
//   2. message.id 会在一段流式回复里重复出现（分片），按它去重。
'use strict'

const meta = {
  id: 'claude',
  label: 'Claude Code',
  vendor: 'Anthropic Claude Code',
  badge: 'CC',
  builtin: true,
  unit: 'token',
  paths: ['~/.claude/projects'],
  desc: '读 assistant 行的 message.usage（含 cache_creation / cache_read）',
  fields: [{ id: 'claude', label: 'Claude 今日', unit: 'token' }],
  // 阈值单位是这个来源自己的量纲（token）：单次 2 万算普通痛、6 万算暴击。
  // 编排层不换算，飘在鱼身上的就是这个 token 数。
  damage: [[60000, 'critical'], [20000, 'normal']],
}

const RECENT_MS = 7 * 24 * 60 * 60 * 1000
const BLANK = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, calls: 0 })

function create(api) {
  const { num, parseIso } = api

  const state = {
    tails: new api.TailSet(),
    dayKey: 0,
    today: BLANK(),
    seen: new Map(), // id -> 已计入的 total，用于处理「同一 id 后出现的更大值」
    lastCallAt: 0,
    lastModel: '',
    updatedAt: 0,
    available: false,
    detail: '',
  }

  function poll(now, emit) {
    const files = api.walkFiles(api.expand('~/.claude/projects'), {
      name: /\.jsonl$/i,
      sinceMs: RECENT_MS,
      maxFiles: 300,
    })
    state.available = files.length > 0
    if (!state.available) {
      state.detail = '未找到 ~/.claude/projects 下的会话'
      return
    }

    const day = api.rollDay(now, state, () => { state.today = BLANK(); state.seen.clear() })

    for (const { line, history } of state.tails.read(files.map(f => f.file))) {
      const s = line.trim()
      if (!s || s.charCodeAt(0) !== 123) continue
      let rec
      try {
        rec = JSON.parse(s)
      } catch {
        continue
      }
      if (!rec || rec.type !== 'assistant') continue

      const msg = rec.message || {}
      const usage = msg.usage
      if (!usage) continue
      const model = String(msg.model || '')
      if (model === '<synthetic>') continue // 本地合成行，usage 全 0

      const at = parseIso(rec.timestamp) || now
      if (api.bjDayKey(at) !== day) continue

      const input = num(usage.input_tokens)
      const output = num(usage.output_tokens)
      const cacheRead = num(usage.cache_read_input_tokens)
      const cacheWrite = num(usage.cache_creation_input_tokens)
      const total = input + output + cacheRead + cacheWrite
      if (total <= 0) continue

      const id = String(msg.id || rec.uuid || '') + '@' + String(at)
      const prev = state.seen.get(id)
      if (prev !== undefined && prev >= total) continue // 分片重复
      state.seen.set(id, total)

      state.today.input += input
      state.today.output += output
      state.today.cacheRead += cacheRead
      state.today.cacheWrite += cacheWrite
      state.today.total += total
      state.today.calls += 1
      state.lastCallAt = at
      state.lastModel = model || state.lastModel
      state.updatedAt = now

      if (!history) {
        emit({
          source: 'claude', amount: total, unit: 'token', at,
          tokens: total, input, output, cached: cacheRead, model, id,
        })
      }
    }

    if (state.seen.size > 20000) state.seen = new Map([...state.seen].slice(-2000))
    // 文件在、但一条真 usage 都没有，是 Claude Code 的常见状态（本地合成行占多数），
    // 这种时候要说清楚，否则用户只看「可用=false」会以为插件坏了。
    state.detail = files.length + ' 个会话文件 · 今日 ' + state.today.calls + ' 次'
      + (state.today.calls === 0 ? '（文件里没有可用的 usage 记录）' : '')
  }

  return {
    get available() { return state.available },
    get detail() { return state.detail },
    poll,
    raw(now) {
      return {
        available: state.available,
        todayTokens: state.today.total,
        todayInput: state.today.input,
        todayOutput: state.today.output,
        todayCacheRead: state.today.cacheRead,
        todayCacheWrite: state.today.cacheWrite,
        callsToday: state.today.calls,
        lastCallAt: state.lastCallAt,
        active: now - state.updatedAt < 90 * 1000,
      }
    },
    fields(now, ctx) {
      const t = state.today
      const billable = t.input + t.output + t.cacheWrite
      // 没数据时连单位一起收起来（和 codex / zcode / dsh / workbuddy 一致）
      const has = state.available && t.calls > 0
      return [{
        id: 'claude',
        label: 'Claude 今日',
        unit: has ? 'token' : '',
        value: has ? ctx.fmtTokens(t.total) + ' · ' + t.calls + ' 次' : '--',
        tone: has ? '' : 'off',
        title: state.available
          ? 'Claude Code 今日 ' + t.total + ' tokens · ' + t.calls + ' 次调用\n'
            + '  计费输入 ' + billable + '（新写缓存 ' + t.cacheWrite + '）\n'
            + '  输出 ' + t.output + ' · 缓存命中 ' + t.cacheRead
          : '未找到 ~/.claude/projects 下的会话',
      }]
    },
  }
}

module.exports = { meta, create }
