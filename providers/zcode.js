// providers/zcode.js —— ZCode（智谱 GLM 那套 CLI）
//
// 数据源：~/.zcode/cli/rollout/model-io-sess_*.jsonl
// 每次模型调用的完整 IO 记录（一行一个 JSON）：
//   {
//     "completedAt": "2026-09-29T13:21:34.927Z",
//     "requestId": "becb57fd-...",
//     "model": { "modelId": "GLM-5.3-Flash", "providerId": "bigmodel-api" },
//     "response": { "usage": { inputTokens, outputTokens, totalTokens,
//                              cacheReadTokens, cacheWriteTokens } }
//   }
// 用 requestId 去重。
//
// 注意这个文件很大（单会话实测 1.5MB 起，因为 request.body 里塞了完整 system prompt
// 和全部 tool schema），所以只扫近三天的，而且**只 JSON.parse 需要的行** ——
// 用字符串预筛 `"usage"` 和 `"completedAt"` 再解析，能省掉绝大部分解析开销。
'use strict'

const meta = {
  id: 'zcode',
  label: 'ZCode',
  vendor: 'ZCode CLI（GLM / bigmodel）',
  badge: 'ZC',
  builtin: true,
  unit: 'token',
  paths: ['~/.zcode/cli/rollout'],
  desc: '读 model-io 记录里的 response.usage',
  fields: [{ id: 'zcode', label: 'ZCode 今日', unit: 'token' }],
  // 阈值单位是这个来源自己的量纲（token）：单次 2 万算普通痛、6 万算暴击。
  // 编排层不换算，飘在鱼身上的就是这个 token 数。
  damage: [[60000, 'critical'], [20000, 'normal']],
}

const RECENT_MS = 3 * 24 * 60 * 60 * 1000
const BLANK = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, calls: 0 })

function create(api) {
  const { num, parseIso } = api

  const state = {
    tails: new api.TailSet(),
    dayKey: 0,
    today: BLANK(),
    perModel: new Map(),
    seen: new Set(),
    lastCallAt: 0,
    lastModel: '',
    updatedAt: 0,
    available: false,
    detail: '',
  }

  function poll(now, emit) {
    const files = api.walkFiles(api.expand('~/.zcode/cli/rollout'), {
      name: /^model-io-.*\.jsonl$/i,
      sinceMs: RECENT_MS,
      maxFiles: 200,
    })
    state.available = files.length > 0
    if (!state.available) {
      state.detail = '未找到 ~/.zcode/cli/rollout/model-io-*.jsonl'
      return
    }

    const day = api.rollDay(now, state, () => {
      state.today = BLANK()
      state.perModel = new Map()
      state.seen.clear()
    })

    for (const { line, history } of state.tails.read(files.map(f => f.file))) {
      // 便宜预筛：这两段都是记录里必有的字面量，命中率极低时才走 JSON.parse
      if (line.indexOf('"usage"') < 0 || line.indexOf('"completedAt"') < 0) continue
      let rec
      try {
        rec = JSON.parse(line)
      } catch {
        continue
      }
      const usage = rec && rec.response && rec.response.usage
      if (!usage) continue

      const at = parseIso(rec.completedAt) || now
      if (api.bjDayKey(at) !== day) continue

      const id = String(rec.requestId || (rec.response && rec.response.responseId) || '') + '@' + String(at)
      if (state.seen.has(id)) continue
      state.seen.add(id)

      const input = num(usage.inputTokens)
      const output = num(usage.outputTokens)
      const cacheRead = num(usage.cacheReadTokens)
      const cacheWrite = num(usage.cacheWriteTokens)
      const total = num(usage.totalTokens) || (input + output)
      if (total <= 0) continue

      state.today.input += input
      state.today.output += output
      state.today.cacheRead += cacheRead
      state.today.cacheWrite += cacheWrite
      state.today.total += total
      state.today.calls += 1
      const model = (rec.model && rec.model.modelId) || ''
      state.perModel.set(model, (state.perModel.get(model) || 0) + total)
      state.lastCallAt = at
      state.lastModel = model || state.lastModel
      state.updatedAt = now

      if (!history) {
        emit({
          source: 'zcode', amount: total, unit: 'token', at,
          tokens: total, input, output, cached: cacheRead, model, id,
        })
      }
    }

    if (state.seen.size > 20000) state.seen = new Set([...state.seen].slice(-2000))
    state.detail = files.length + ' 个近三天的 model-io · 今日 ' + state.today.calls + ' 次'
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
        callsToday: state.today.calls,
        lastCallAt: state.lastCallAt,
        lastModel: state.lastModel,
        active: now - state.updatedAt < 90 * 1000,
      }
    },
    fields(now, ctx) {
      const t = state.today
      const models = [...state.perModel.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([m, v]) => '  ' + (m || '(未知模型)') + '  ' + ctx.fmtTokens(v))
        .join('\n')
      // 没数据时连单位一起收起来（和 codex / claude / dsh / workbuddy 一致）
      const has = state.available && t.calls > 0
      return [{
        id: 'zcode',
        label: 'ZCode 今日',
        unit: has ? 'token' : '',
        value: has ? ctx.fmtTokens(t.total) + ' · ' + t.calls + ' 次' : '--',
        tone: has ? '' : 'off',
        title: state.available
          ? 'ZCode 今日 ' + t.total + ' tokens · ' + t.calls + ' 次调用\n'
            + '  输入 ' + t.input + ' · 输出 ' + t.output + ' · 缓存命中 ' + t.cacheRead
            + (models ? '\n按模型：\n' + models : '')
          : '未找到 ~/.zcode/cli/rollout/model-io-*.jsonl',
      }]
    },
  }
}

module.exports = { meta, create }
