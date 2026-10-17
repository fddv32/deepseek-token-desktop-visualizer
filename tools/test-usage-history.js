// 每日用量账本（shared/history.js）的自测。纯逻辑，不启动 Electron。
//
//   node tools\test-usage-history.js
'use strict'

const H = require('../shared/history')

let pass = 0
let fail = 0
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + label) }
  else { fail += 1; console.log('  \u2717 ' + label + (extra ? '  -> ' + extra : '')) }
}
const prov = o => ({ providers: o })

console.log('— 从快照抽数 —')
{
  const e = H.entryOf(prov({
    workbuddy: { todayCredit: 2.25, callsToday: 5 },
    dsh: { todayTokens: 1000, todayCost: 1.5, callsToday: 3 },
    codex: { todayTokens: 5000, callsToday: 2 },
    manual: { todayTokens: 10, todayCost: 0.2, callsToday: 1 },
  }))
  ok('WorkBuddy 只记积分（它没有 token 这个概念）',
    e.workbuddy.credit === 2.25 && e.workbuddy.tokens === undefined, JSON.stringify(e.workbuddy))
  ok('DSH 记 token + 人民币', e.dsh.tokens === 1000 && e.dsh.cost === 1.5)
  ok('codex 记 token', e.codex.tokens === 5000)
  ok('manual 两样都记', e.manual.tokens === 10 && e.manual.cost === 0.2)
  ok('没报的来源不凭空建条目', !('claude' in e))

  const t = H.totalOf(e)
  ok('合计：token 跨来源求和（不含积分）', t.tokens === 6010, String(t.tokens))
  ok('合计：积分单独一列', t.credit === 2.25, String(t.credit))
  ok('合计：金额单独一列（不折成 token）', t.cost === 1.7, String(t.cost))
  ok('合计：次数求和', t.calls === 11, String(t.calls))
}

console.log('— 合并：只增不减 —')
{
  let days = {}
  days = H.merge(days, '2026-10-02', { dsh: { tokens: 9000, calls: 9 } })
  days = H.merge(days, '2026-10-02', { dsh: { tokens: 4000, calls: 4 } })
  ok('数字变小不倒退（插件重载后累计器从零重建会这样）',
    days['2026-10-02'].dsh.tokens === 9000, String(days['2026-10-02'].dsh.tokens))
  days = H.merge(days, '2026-10-02', { dsh: { tokens: 12000, calls: 12 } })
  ok('数字变大时跟上', days['2026-10-02'].dsh.tokens === 12000)
  ok('只占一天', Object.keys(days).length === 1)
  ok('merge 不改原对象（函数式）', (() => {
    const a = H.merge({}, '2026-10-02', { dsh: { tokens: 1 } })
    const b = H.merge(a, '2026-10-02', { dsh: { tokens: 2 } })
    return a['2026-10-02'].dsh.tokens === 1 && b['2026-10-02'].dsh.tokens === 2
  })())
  ok('total 自动跟着更新', days['2026-10-02'].total.tokens === 12000)
}

console.log('— 按范围汇总 —')
{
  let days = {}
  const day = 86400000
  const now = new Date(2026, 9, 2, 15, 0, 0).getTime()   // 本地 10-02 15:00
  days = H.merge(days, '2026-09-25', { dsh: { tokens: 100, calls: 1 } })
  days = H.merge(days, '2026-10-01', { dsh: { tokens: 200, calls: 2 } })
  days = H.merge(days, '2026-10-02', { dsh: { tokens: 300, calls: 3 } })

  const d7 = H.summarize(days, '7d', now)
  ok('7 天窗口包含 10-01 和 10-02，不含 09-25',
    d7.total.tokens === 500 && d7.series.length === 2, JSON.stringify(d7.series.map(s => s.day)))
  ok('series 升序', d7.series[0].day === '2026-10-01' && d7.series[1].day === '2026-10-02')
  ok('activeDays 按「有调用」算', d7.activeDays === 2, String(d7.activeDays))
  ok('bySource 累加到同一个来源上', d7.bySource.dsh.tokens === 500)

  const all = H.summarize(days, 'all', now)
  ok('all 范围含全部三天', all.total.tokens === 600, String(all.total.tokens))

  const today = H.summarize(days, 'today', now)
  ok('today 只有今天', today.total.tokens === 300 && today.days === 1)

  ok('perDayTokens 用 activeDays 除（不是天数）', d7.perDayTokens === 250, String(d7.perDayTokens))
  ok('没有量时均价给 0 而不是 Infinity/NaN',
    H.summarize({}, '7d', now).perDayCost === 0 && H.summarize({}, '7d', now).per100mTokens === 0)
  ok('per100mTokens = 每亿 token 花多少', (() => {
    const s = H.summarize(H.merge({}, '2026-10-02', { dsh: { tokens: 1e8, cost: 3 } }), 'today', now)
    return Math.abs(s.per100mTokens - 3) < 1e-9
  })())
}

console.log('— 日期键 —')
{
  const d = new Date(2026, 9, 2, 23, 30, 0)
  ok('dayKey 用本地时区（用户嘴里的「今天」是他表上的今天）', H.dayKey(d.getTime()) === '2026-10-02',
    H.dayKey(d.getTime()))
  ok('dayStart 可逆', H.dayKey(H.dayStart('2026-10-02')) === '2026-10-02')
  ok('dayStart 对坏输入给 NaN', Number.isNaN(H.dayStart('乱写')))
}

console.log('— 清理 —')
{
  let days = {}
  for (const k of ['2026-09-01', '2026-09-30', '2026-10-01', '2026-10-02']) {
    days = H.merge(days, k, { dsh: { tokens: 1 } })
  }
  const p = H.prune(days, 3)
  ok('只留最近 3 天（字典序就是时间序）',
    Object.keys(p).length === 3 && !p['2026-09-01'], Object.keys(p).join(','))
  ok('不足 keep 天时原样返回', H.prune({ '2026-10-02': {} }, 5)['2026-10-02'] !== undefined)
}

console.log('— 落盘（createStore）—')
{
  const mem = {}
  const fakeFs = {
    readFileSync: f => { if (mem[f] === undefined) throw new Error('ENOENT'); return mem[f] },
    writeFileSync: (f, s) => { mem[f] = s },
  }
  const st = H.createStore(fakeFs, 'x.json')
  ok('首次运行不炸（文件不在）', st.all() && Object.keys(st.all()).length === 0)

  const now = Date.now()
  st.record({ providers: { dsh: { todayTokens: 500, callsToday: 2 } } }, now)
  ok('record 后账本里有今天', Object.keys(st.all()).length === 1)
  // lastFlush 从 0 起算 => 首次 record 必然落一次盘（刚起来就该写一次，是对的）
  ok('首次 record 就落盘', mem['x.json'] !== undefined)

  mem['x.json'] = 'MARK'
  st.record({ providers: { dsh: { todayTokens: 900, callsToday: 3 } } }, now + 1000)
  ok('数字变了，但 15 秒节流内不写盘', mem['x.json'] === 'MARK')

  st.record({ providers: { dsh: { todayTokens: 900, callsToday: 3 } } }, now + 20000)
  ok('过了节流窗口才写', mem['x.json'] !== 'MARK')

  ok('flush(true) 强制写', st.flush(true) === true && mem['x.json'] !== undefined)
  const saved = JSON.parse(mem['x.json'])
  ok('落盘带版本号（将来换结构能认出来）', saved.version === H.VERSION)
  ok('落盘结构是 {version, days}', !!saved.days)

  const st2 = H.createStore(fakeFs, 'x.json')
  ok('重新打开能读回来（值是最新那个 900，不是最开始的 500）',
    Object.values(st2.all())[0].dsh.tokens === 900,
    String(Object.values(st2.all())[0].dsh.tokens))

  mem['x.json'] = '{不是 JSON'
  const st3 = H.createStore(fakeFs, 'x.json')
  ok('文件坏了当空账本（历史丢了不该拦住启动）', Object.keys(st3.all()).length === 0)

  mem['x.json'] = JSON.stringify({ version: 999, days: { '2026-10-02': {} } })
  const st4 = H.createStore(fakeFs, 'x.json')
  ok('版本对不上也当空账本', Object.keys(st4.all()).length === 0)
}

console.log('— 边界 —')
{
  ok('空快照不炸', JSON.stringify(H.entryOf(null)) === '{}')
  ok('providers 缺失不炸', JSON.stringify(H.entryOf({})) === '{}')
  const e = H.entryOf(prov({ dsh: { todayTokens: -5, todayCost: 'abc' } }))
  ok('负数照实记（由取 max 兜底，不在这里悄悄改数）', e.dsh.tokens === -5 && e.dsh.cost === 0,
    JSON.stringify(e.dsh))
}

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exit(fail === 0 ? 0 : 1)
