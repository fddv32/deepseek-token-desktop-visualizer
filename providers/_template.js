// ⚠️ 这是模板，不是插件 —— 文件名以 `_` 开头，加载器会跳过它。
//
// 想加一个数据源：把本文件复制成 `providers/my-tool.js`（内置）
// 或 `~/.whalepet/providers/my-tool.js`（用户级），改完点面板里的「重载插件」。
//
// 完整说明见 providers/README.md。下面是能跑的最小骨架。
'use strict'

const RECENT_MS = 3 * 24 * 60 * 60 * 1000

const meta = {
  id: 'mytool',            // 全局唯一。与内置插件重名会覆盖内置
  label: 'MyTool',
  vendor: '我自己写的 CLI',
  badge: 'MY',             // 面板上的小角标，2~3 个字符
  unit: 'token',           // 'token'（token）/ 'credit'（积分）/ 'CNY'（人民币）
  paths: ['~/.mytool/logs'],   // 面板里展示「读哪里」
  desc: '读 ~/.mytool/logs/*.jsonl 里的 usage 行',
  // 字段表：决定「设置 → 桌宠上显示」里能勾什么。unit 会渲染成数字后的小字。
  fields: [{ id: 'mytool', label: 'MyTool 今日', unit: 'token', desc: '今日累计' }],
  // 受击阈值 [[金额下限, 等级], ...]，从高到低。等级：pain-weak / pain-normal / critical。
  // 不写就用默认（>=1 算普通痛）。
  damage: [[100000, 'critical'], [30000, 'pain-normal']],
}

const BLANK = () => ({ tokens: 0, calls: 0 })

function create(api) {
  const { num, parseIso } = api

  const state = {
    tails: new api.TailSet(),   // 增量读一批文件，并且帮你区分「历史」和「新到」
    dayKey: 0,
    today: BLANK(),
    seen: new Set(),
    updatedAt: 0,
    available: false,
    detail: '',
  }

  function poll(now, emit) {
    const files = api.walkFiles(api.expand('~/.mytool/logs'), {
      name: /\.jsonl$/i,
      sinceMs: RECENT_MS,
    })
    state.available = files.length > 0
    if (!state.available) {
      state.detail = '没找到日志'
      return
    }

    // 跨天自动清零（北京时间 00:00）
    const day = api.rollDay(now, state, () => { state.today = BLANK(); state.seen.clear() })

    for (const { line, history } of state.tails.read(files.map(f => f.file))) {
      let rec
      try {
        rec = JSON.parse(line)
      } catch {
        continue // 写到一半的半行；Tailer 会把尾巴留到下一轮
      }
      if (!rec) continue

      const at = parseIso(rec.timestamp) || now
      if (api.bjDayKey(at) !== day) continue

      const id = String(rec.id || at)
      if (state.seen.has(id)) continue
      state.seen.add(id)

      const tokens = num(rec.totalTokens)
      state.today.tokens += tokens
      state.today.calls += 1
      state.updatedAt = now

      // history=true 表示这是一启动就读到的**历史账**，只累计、不发事件。
      // 忘了这个判断，桌宠每次启动都会为旧记录放一串受击动画。
      if (!history) {
        emit({ source: meta.id, amount: tokens, unit: 'token', at, id })
      }
    }

    if (state.seen.size > 20000) state.seen = new Set([...state.seen].slice(-2000))
    state.detail = files.length + ' 个文件 · 今日 ' + state.today.calls + ' 次'
  }

  return {
    get available() { return state.available },
    get detail() { return state.detail },
    poll,
    // raw() 返回的数字会被「今日已用」汇总字段读取：
    //   todayTokens 计入 token 合计，todayCredit 计入积分合计（没有就不填）。
    raw(now) {
      return {
        available: state.available,
        todayTokens: state.today.tokens,
        callsToday: state.today.calls,
        active: now - state.updatedAt < 90 * 1000,
      }
    },
    // fields() 把数据变成信息条上的文字：label 是暗色小字，value 是亮色数字。
    // 只返回**已经配置到信息条上的**字段也不会出错 —— 编排层按 id 挑。
    fields(now, ctx) {
      const has = state.available && state.today.calls > 0
      return [{
        id: 'mytool',
        label: 'MyTool 今日',
        value: has ? ctx.fmtTokens(state.today.tokens) + ' · ' + state.today.calls + ' 次' : '--',
        unit: has ? 'token' : '',
        tone: has ? '' : 'off', // '' / off / warn / danger / peak / valley
        title: '鼠标停在信息条上时的完整明细',
      }]
    },
  }
}

module.exports = { meta, create }
