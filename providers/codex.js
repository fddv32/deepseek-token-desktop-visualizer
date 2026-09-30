// providers/codex.js —— OpenAI Codex CLI（用户口中的「gpt」）
//
// 数据源：~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
// 每次模型调用落一条 token_usage_record：
//   {
//     "timestamp": "2026-09-29T11:44:47.822Z",
//     "type": "token_usage_record",
//     "payload": {
//       "response_id": "5ea785dd-...",
//       "usage": { input_tokens, cached_input_tokens, cache_write_input_tokens,
//                  output_tokens, reasoning_output_tokens, total_tokens }
//     }
//   }
// 用 response_id 去重：一次响应只会写一条，但重试/续写会让同一个 response_id 再出现。
//
// 三个「读一批 jsonl」的插件（codex / claude / zcode）结构是一样的，公共部分
// （增量读、跨天重置、按天累计）都交给 api.TailSet 和 api.rollDay，这里只留解析。
'use strict'

const meta = {
  id: 'codex',
  label: 'Codex',
  vendor: 'OpenAI Codex CLI',
  badge: 'GPT',
  builtin: true,
  unit: 'token',
  paths: ['~/.codex/sessions'],
  desc: '读 rollout 里的 token_usage_record（input/output/cached/reasoning）',
  fields: [{ id: 'codex', label: 'Codex 今日', unit: 'token' }],
  // 阈值单位是这个来源自己的量纲（token）：单次 2 万算普通痛、6 万算暴击。
  // 编排层不换算，飘在鱼身上的就是这个 token 数。
  damage: [[60000, 'critical'], [20000, 'normal']],
}

const RECENT_MS = 3 * 24 * 60 * 60 * 1000 // 只扫最近三天还在写的 rollout
const BLANK = () => ({ input: 0, output: 0, cached: 0, reasoning: 0, total: 0, calls: 0 })

function create(api) {
  const { num, parseIso } = api

  const state = {
    tails: new api.TailSet(),
    dayKey: 0,
    today: BLANK(),
    seen: new Set(),
    lastCallAt: 0,
    updatedAt: 0,
    available: false,
    detail: '',
  }

  function poll(now, emit) {
    const files = api.walkFiles(api.expand('~/.codex/sessions'), {
      name: /^rollout-.*\.jsonl$/i,
      sinceMs: RECENT_MS,
      maxFiles: 200,
    })
    state.available = files.length > 0
    if (!state.available) {
      state.detail = '未找到 ~/.codex/sessions 下的 rollout'
      return
    }

    const day = api.rollDay(now, state, () => { state.today = BLANK(); state.seen.clear() })

    for (const { line, history } of state.tails.read(files.map(f => f.file))) {
      const s = line.trim()
      if (!s || s.charCodeAt(0) !== 123 /* { */) continue
      let rec
      try {
        rec = JSON.parse(s)
      } catch {
        continue
      }
      if (!rec || rec.type !== 'token_usage_record') continue

      const at = parseIso(rec.timestamp) || now
      if (api.bjDayKey(at) !== day) continue

      const p = rec.payload || {}
      const usage = p.usage || p.turn_token_usage
      if (!usage) continue

      const id = String(p.response_id || rec.ordinal || '') + '@' + String(at)
      if (state.seen.has(id)) continue
      state.seen.add(id)

      const input = num(usage.input_tokens)
      const output = num(usage.output_tokens)
      const cached = num(usage.cached_input_tokens)
      const reasoning = num(usage.reasoning_output_tokens)
      const total = num(usage.total_tokens) || (input + output)
      if (total <= 0) continue

      state.today.input += input
      state.today.output += output
      state.today.cached += cached
      state.today.reasoning += reasoning
      state.today.total += total
      state.today.calls += 1
      state.lastCallAt = at
      state.updatedAt = now

      // history=true 是「这个文件的首轮读取」= 启动前就存在的历史账，只累计、不播动画
      if (!history) {
        emit({ source: 'codex', amount: total, unit: 'token', at, tokens: total, input, output, cached, id })
      }
    }

    if (state.seen.size > 20000) state.seen = new Set([...state.seen].slice(-2000))
    state.detail = files.length + ' 个近三天的 rollout · 今日 ' + state.today.calls + ' 次'
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
        todayCached: state.today.cached,
        todayReasoning: state.today.reasoning,
        callsToday: state.today.calls,
        lastCallAt: state.lastCallAt,
        active: now - state.updatedAt < 90 * 1000,
      }
    },
    fields(now, ctx) {
      const t = state.today
      const pct = t.input > 0 ? Math.round(t.cached / t.input * 100) : 0
      // 没数据时连单位一起收起来：`-- token` 里的单位纯是噪音，
      // `--` 本身已经说明「今天还没数」。三个日志型插件（codex/claude/zcode）
      // 和 dsh / workbuddy / manual 统一按这条来，别一半带单位一半不带。
      const has = state.available && t.calls > 0
      return [{
        id: 'codex',
        label: 'Codex 今日',
        unit: has ? 'token' : '',
        value: has ? ctx.fmtTokens(t.total) + ' · ' + t.calls + ' 次' : '--',
        tone: has ? '' : 'off',
        title: state.available
          ? 'Codex 今日 ' + t.total + ' tokens · ' + t.calls + ' 次调用\n'
            + '  输入 ' + t.input + '（缓存命中 ' + t.cached + '，约 ' + pct + '%）\n'
            + '  输出 ' + t.output + '（其中推理 ' + t.reasoning + '）'
          : '未找到 ~/.codex/sessions 下的 rollout',
      }]
    },
  }
}

module.exports = { meta, create }
