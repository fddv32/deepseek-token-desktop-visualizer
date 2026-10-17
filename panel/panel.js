// 用量面板的前端。
//
// 分工和老规矩一致：**数字全在主进程算好**，这里只负责画。窗口只拿到
// `panel.load()` 的一份快照 + 后续每 2.5 秒推来的 `usage`，
// 自己不做任何跨来源的加总 —— 不然桌面上信息条和这里迟早会算出两个数。
'use strict'

const el = id => document.getElementById(id)
const api = window.panel

const state = {
  app: null,
  config: null,     // usage.publicConfig()：字段列表在这里
  catalog: [],
  history: null,    // history.js 的 summarize() 结果：series / total / bySource
  snapshot: null,
  ovMetric: 'tokens',
  dlMetric: 'tokens',
  dlRange: 30,
  days: 30,
}

/* ---------- 小工具 ---------- */

/** token 动辄上千万，读起来得缩；金额小，小数位要给够。 */
function fmt(v, kind) {
  const n = Number(v) || 0
  if (kind === 'cost') return '¥' + (n >= 100 ? n.toFixed(0) : n.toFixed(n < 1 ? 3 : 2))
  if (kind === 'credit') return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : n.toFixed(n < 10 ? 2 : n < 100 ? 1 : 0)
  if (kind === 'calls') return String(Math.round(n))
  if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 亿'
  if (n >= 1e4) return (n / 1e4).toFixed(n >= 1e6 ? 0 : 1) + ' 万'
  return String(Math.round(n))
}

/** 今天各来源的数字（从实时快照里现取，不等历史落盘）。 */
function todayFromSnapshot() {
  const out = { tokens: 0, credit: 0, cost: 0, calls: 0, bySource: {} }
  const prov = (state.snapshot && state.snapshot.providers) || {}
  for (const [id, raw] of Object.entries(prov)) {
    if (!raw || raw.available === false) continue
    const t = Number(raw.todayTokens) || 0
    const c = Number(raw.todayCredit) || 0
    const m = Number(raw.todayCost) || 0
    const k = Number(raw.callsToday) || 0
    if (!t && !c && !m && !k) continue
    out.tokens += t; out.credit += c; out.cost += m; out.calls += k
    out.bySource[id] = { tokens: t, credit: c, cost: m, calls: k, raw }
  }
  return out
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]))
}

function labelOf(id) {
  const hit = (state.catalog || []).find(f => f.id === id)
  return (hit && hit.label) || id
}

/**
 * 缓存命中率。各来源的账本字段是**三套口径**（hit/miss 分列、input 不含缓存、
 * input 含缓存），归一化在各自插件里做完了 —— 它们都往 raw() 里放
 * `cacheHitTokens` / `cacheMissTokens` 这一对。所以面板这边一律按 'pair' 算，
 * 不需要知道谁家的 input 含不含缓存，也就不会算出第二个数。
 */
function hitRateOf(raw) {
  if (!window.CacheHit) return null
  return window.CacheHit.rate({
    mode: 'pair',
    hit: raw && raw.cacheHitTokens,
    miss: raw && raw.cacheMissTokens,
  })
}

/** 一个来源用什么量纲，是它自己报的字段决定的 —— 不要替它猜。 */
function sourceValue(s) {
  if (s.tokens) return fmt(s.tokens) + ' token'
  if (s.credit) return fmt(s.credit, 'credit') + ' 积分'
  if (s.cost) return fmt(s.cost, 'cost')
  return '—'
}

/* ---------- 切页 ---------- */

const PAGES = ['overview', 'daily', 'source', 'fields']

function go(id, remember) {
  if (PAGES.indexOf(id) < 0) id = 'overview'
  for (const p of PAGES) {
    el('page-' + p).classList.toggle('on', p === id)
  }
  for (const b of document.querySelectorAll('.nav-item')) {
    b.classList.toggle('on', b.dataset.page === id)
  }
  document.querySelector('.content').scrollTop = 0
  // 用 hash 指定页打开时**不记**，否则验收脚本跑一趟就把用户"上次看的那页"顶掉了。
  if (remember !== false) {
    try { localStorage.setItem('whalepet.panel.page', id) } catch { /* 记不住就从第一页开始 */ }
  }
  // 图表的宽度依赖容器的实际宽度：隐藏时是 0，切过来必须重画一次。
  if (id === 'overview') renderCharts()
  if (id === 'daily') renderCharts(true)
}

/* ---------- ① 概览 ---------- */

function renderOverview() {
  const t = todayFromSnapshot()
  const cards = [
    { label: '今日 token', value: fmt(t.tokens), sub: '所有来源合计' },
    { label: '今日积分', value: fmt(t.credit, 'credit'), sub: 'WorkBuddy' },
    { label: '今日金额', value: fmt(t.cost, 'cost'), sub: 'DeepSeek / 手动' },
    { label: '今日调用', value: fmt(t.calls, 'calls') + ' 次', sub: '各来源合计' },
  ]
  el('ov-cards').innerHTML = cards.map(c => `
    <div class="card stat">
      <div class="stat-label">${esc(c.label)}</div>
      <div class="stat-value">${esc(c.value)}</div>
      <div class="stat-sub">${esc(c.sub)}</div>
    </div>`).join('')

  const srcs = Object.keys(t.bySource)
  el('ov-count').textContent = srcs.length ? srcs.length + ' 个在报数' : ''
  el('ov-sources').innerHTML = srcs.length === 0
    ? '<div class="card empty">今天还没有任何来源报数</div>'
    : srcs.map(id => {
      const s = t.bySource[id]
      const bits = []
      if (s.raw.todayInput || s.raw.todayOutput) {
        bits.push('入 ' + fmt(s.raw.todayInput || 0) + ' / 出 ' + fmt(s.raw.todayOutput || 0))
      }
      const cr = hitRateOf(s.raw)
      if (cr) bits.push('缓存命中 ' + cr.pct.toFixed(1) + '%')
      if (s.calls) bits.push(s.calls + ' 次')
      return `
        <div class="card">
          <div class="card-head"><b>${esc(labelOf(id))}</b><span class="tag">${esc(id)}</span></div>
          <div class="card-value">${esc(sourceValue(s))}</div>
          ${bits.length ? '<div class="card-sub">' + bits.map(esc).join(' · ') + '</div>' : ''}
        </div>`
    }).join('')

  const peak = state.snapshot && state.snapshot.peak
  el('ov-peak').textContent = peak ? peak.label + (peak.weekend ? '（周末）' : '') : ''
}

/* ---------- ② 每日 ---------- */

/**
 * 取要画的每一天。
 *
 * history.js 的 series 只包含**账本里真有的**日期（它不凭空造日期，这是对的：
 * 账本不该写没发生过的天）。但折线图需要一条**等距**的时间轴 —— 只给有记录的那几天，
 * 月初只有一条数据时横轴就只有一个点，看不出趋势。所以在这里补齐：
 * 缺的那天填 0，形状和账本里的一天一模一样。
 */
function dlRows() {
  const s = (state.history && state.history.series) || []
  const byDay = new Map(s.map(r => [r.day, r]))
  const now = new Date()
  const key = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const out = []
  for (let i = state.dlRange - 1; i >= 0; i -= 1) {
    const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    const k = key(dt)
    out.push(byDay.get(k) || { day: k, tokens: 0, credit: 0, cost: 0, calls: 0 })
  }
  return out
}

function renderDaily() {
  const rows = dlRows()
  const field = state.dlMetric
  const total = rows.reduce((a, r) => a + (Number(r[field]) || 0), 0)
  const active = rows.filter(r => (Number(r[field]) || 0) > 0).length
  const peakRow = rows.reduce((a, r) => ((Number(r[field]) || 0) > (Number(a[field]) || 0) ? r : a), rows[0] || {})
  const unit = field === 'cost' ? '¥' : field === 'credit' ? '积分' : field === 'calls' ? '次' : 'token'
  const lb = r => String((r && r.day) || '').slice(5)
  el('dl-summary').textContent = rows.length === 0 ? ''
    : `这 ${rows.length} 天合计 ${fmt(total, field)} ${unit} · 有记录的 ${active} 天` +
      (active ? ` · 最高 ${lb(peakRow)}（${fmt(peakRow[field], field)}）` : '')

  el('dl-body').innerHTML = rows
    .filter(r => r.tokens || r.credit || r.cost || r.calls)
    .slice().reverse()
    .map(r => `<tr>
        <td>${esc(lb(r))}</td>
        <td class="num">${r.tokens ? esc(fmt(r.tokens)) : '<span class="muted">—</span>'}</td>
        <td class="num">${r.credit ? esc(fmt(r.credit, 'credit')) : '<span class="muted">—</span>'}</td>
        <td class="num">${r.cost ? esc(fmt(r.cost, 'cost')) : '<span class="muted">—</span>'}</td>
        <td class="num">${r.calls ? esc(fmt(r.calls, 'calls')) : '<span class="muted">—</span>'}</td>
      </tr>`).join('')
    || '<tr><td colspan="5" class="muted">还没有记录</td></tr>'
}

/* ---------- ③ 来源 ---------- */

function renderSource() {
  const t = todayFromSnapshot()
  const hist = (state.history && state.history.bySource) || {}
  const ids = new Set([...Object.keys(t.bySource), ...Object.keys(hist)])
  el('src-count').textContent = ids.size ? ids.size + ' 个' : ''

  if (ids.size === 0) {
    el('src-list').innerHTML = '<div class="card empty">还没有任何数据源报数</div>'
    return
  }

  el('src-list').innerHTML = [...ids].map(id => {
    const now = t.bySource[id]
    const sum = hist[id]
    const raw = (now && now.raw) || {}
    const rows = []
    const push = (k, v) => { if (v) rows.push(`<tr><td>${esc(k)}</td><td class="num">${esc(v)}</td></tr>`) }

    push('token 合计', now ? fmt(now.tokens) : '')
    push('输入', raw.todayInput ? fmt(raw.todayInput) : '')
    push('输出', raw.todayOutput ? fmt(raw.todayOutput) : '')
    // 缓存一律用归一后的那一对（各来源里面已经换算好），不再各自展示
    // 「缓存读取 / 写入 / 命中」三个字段 —— 那三个名字在不同来源指的是不同的东西。
    push('命中 token', raw.cacheHitTokens ? fmt(raw.cacheHitTokens) : '')
    push('未命中 token', raw.cacheMissTokens ? fmt(raw.cacheMissTokens) : '')
    push('推理 token', raw.todayReasoning ? fmt(raw.todayReasoning) : '')
    push('积分', now && now.credit ? fmt(now.credit, 'credit') : '')
    push('金额', now && now.cost ? fmt(now.cost, 'cost') : '')
    push('调用次数', now && now.calls ? fmt(now.calls, 'calls') + ' 次' : '')
    push('缓存命中率', (hitRateOf(raw) ? hitRateOf(raw).pct.toFixed(1) + '%' : ''))
    push('最近模型', raw.lastModel || '')
    push('上下文占用', raw.ctxTokens ? fmt(raw.ctxTokens) : '')

    const cum = sum ? [
      sum.tokens ? fmt(sum.tokens) + ' token' : '',
      sum.credit ? fmt(sum.credit, 'credit') + ' 积分' : '',
      sum.cost ? fmt(sum.cost, 'cost') : '',
      sum.calls ? fmt(sum.calls, 'calls') + ' 次' : '',
    ].filter(Boolean).join(' · ') : '还没有累计'

    return `
      <div class="card src">
        <div class="card-head">
          <b>${esc(labelOf(id))}</b>
          <span class="tag">${esc(id)}</span>
          ${now ? '' : '<span class="tag off">今天没报数</span>'}
        </div>
        <div class="src-cols">
          <div>
            <div class="src-title">今日</div>
            <div class="src-main">${esc(now ? sourceValue(now) : '—')}</div>
            <table class="tbl mini">${rows.join('')}</table>
          </div>
          <div>
            <div class="src-title">最近 ${state.days} 天累计</div>
            <div class="src-cum">${esc(cum)}</div>
          </div>
        </div>
      </div>`
  }).join('')
}

/* ---------- ④ 字段 ---------- */

function renderFields() {
  // 字段列表在 publicConfig() 里（= 回包的 res.usage），不在 appState()
  const chosen = (state.config && state.config.fields) || []
  const known = new Set((state.catalog || []).map(f => f.id))
  el('field-n').textContent = String(chosen.length)
  el('field-count').textContent = chosen.length + ' 项'

  el('field-list').innerHTML = chosen.length === 0
    ? '<div class="card empty">信息条上一个字段都没有 —— 从下面挑几个加进来</div>'
    : chosen.map((id, i) => {
      const f = (state.catalog || []).find(x => x.id === id) || {}
      return `
        <div class="card row">
          <div class="row-main">
            <b>${esc(f.label || id)}</b>
            <div class="card-sub">${esc(f.desc || '')}</div>
          </div>
          <button class="mv" data-up="${esc(id)}" ${i === 0 ? 'disabled' : ''} title="上移">↑</button>
          <button class="mv" data-down="${esc(id)}" ${i === chosen.length - 1 ? 'disabled' : ''} title="下移">↓</button>
          <button class="btn ghost" data-del="${esc(id)}">移除</button>
        </div>`
    }).join('')

  const pool = (state.catalog || []).filter(f => !chosen.includes(f.id))
  el('field-pool').innerHTML = pool.length === 0
    ? '<span class="muted">能加的都在上面了</span>'
    : pool.map(f => `
      <button class="chip-add" data-add="${esc(f.id)}" title="${esc(f.desc || '')}">
        ＋ ${esc(f.label)}<span class="chip-id">${esc(f.id)}</span>
      </button>`).join('')

  el('field-add').innerHTML = '<span class="muted">提示：字段顺序 = 信息条上从左到右的顺序；装/卸插件会让可用字段跟着变。</span>'
}

/* ---------- 图表 ---------- */

function renderCharts(dailyOnly) {
  if (!dailyOnly && el('page-overview').classList.contains('on')) {
    const rows = dlRows().slice(-7)
    window.Chart.line(el('ov-chart'), rows, state.ovMetric)
  }
  if (el('page-daily').classList.contains('on')) {
    window.Chart.line(el('dl-chart'), dlRows(), state.dlMetric)
  }
}

/* ---------- 事件 ---------- */

function bind() {
  for (const b of document.querySelectorAll('.nav-item')) {
    b.addEventListener('click', () => go(b.dataset.page))
  }

  el('ov-metric').addEventListener('click', ev => {
    const b = ev.target.closest('button')
    if (!b) return
    state.ovMetric = b.dataset.metric
    for (const x of el('ov-metric').children) x.classList.toggle('on', x === b)
    renderCharts()
  })
  el('dl-metric').addEventListener('click', ev => {
    const b = ev.target.closest('button')
    if (!b) return
    state.dlMetric = b.dataset.metric
    for (const x of el('dl-metric').children) x.classList.toggle('on', x === b)
    renderDaily(); renderCharts(true)
  })
  el('dl-range').addEventListener('click', ev => {
    const b = ev.target.closest('button')
    if (!b) return
    state.dlRange = Number(b.dataset.days) || 30
    for (const x of el('dl-range').children) x.classList.toggle('on', x === b)
    renderDaily(); renderCharts(true)
  })

  // 字段增删排 —— 每次都是整份新数组交给主进程，主进程负责收拾干净。
  el('page-fields').addEventListener('click', async ev => {
    const chosen = (state.config && state.config.fields) || []
    const add = ev.target.closest('[data-add]')
    const del = ev.target.closest('[data-del]')
    const up = ev.target.closest('[data-up]')
    const down = ev.target.closest('[data-down]')
    let next = null
    if (add) next = chosen.concat([add.dataset.add])
    else if (del) next = chosen.filter(x => x !== del.dataset.del)
    else if (up) {
      const i = chosen.indexOf(up.dataset.up)
      if (i > 0) { next = chosen.slice(); [next[i - 1], next[i]] = [next[i], next[i - 1]] }
    } else if (down) {
      const i = chosen.indexOf(down.dataset.down)
      if (i >= 0 && i < chosen.length - 1) { next = chosen.slice(); [next[i + 1], next[i]] = [next[i], next[i + 1]] }
    }
    if (!next) return
    const res = await api.setFields(next)
    applyBundle(res)
  })

  window.addEventListener('resize', () => renderCharts())
}

/**
 * 主进程回包只带被改动的那几块，所以合并逻辑写一遍就够。
 *
 * 回包的形状是 `{ usage, providers, app, ... }`，**没有 ok 字段**（见 main.js 的 bundle()）——
 * 别去判 res.ok，那会永远不进这个分支，表现就是「接口明明调到了，界面却一直空着」。
 *
 * ⚠ `res.usage` 是 **`usage.publicConfig()`**（里面装着 `fields` 这些**配置**），
 * 不是采集快照。字段页要的就是它 —— `appState()` 里没有 fields，别去那儿找。
 * 实时数字走 `usage` 事件推来的 snapshot。
 */
function applyBundle(res) {
  if (!res) return
  if (res.app) state.app = res.app
  if (res.usage) state.config = res.usage
  if (res.catalog) state.catalog = res.catalog
  if (res.history) state.history = res.history
  renderOverview(); renderDaily(); renderSource(); renderFields(); renderCharts()
}

async function boot() {
  bind()
  const res = await api.load()
  if (res) {
    if (res.app) state.app = res.app
    if (res.usage) state.config = res.usage
    state.catalog = res.catalog || []
    state.days = res.days || 30
    state.history = res.history || { series: [], total: {}, bySource: {}, days: 0 }
    el('nav-ver').textContent = 'v' + ((state.app && state.app.version) || '')
    el('poll-hint').textContent = '每 ' + Math.round(((state.app && state.app.pollMs) || 2500) / 1000) + ' 秒刷新'

    // 默认指标选**真有数**的那一个。上来就画 token，而手里只有积分在走的话，
    // 曲线是一条贴底的直线 —— 看着像面板坏了，其实是选错了指标。
    const seed = ['tokens', 'credit', 'cost', 'calls']
      .find(k => dlRows().some(r => (Number(r[k]) || 0) > 0))
    if (seed) {
      state.ovMetric = seed
      state.dlMetric = seed
      for (const id of ['ov-metric', 'dl-metric']) {
        for (const b of el(id).children) b.classList.toggle('on', b.dataset.metric === seed)
      }
    }
  }
  renderOverview(); renderDaily(); renderSource(); renderFields()

  let page = 'overview'
  let remember = true
  // hash 优先（验收脚本指定页），其次记上次那一页，最后兜底第一页
  const hash = (location.hash || '').replace('#', '')
  if (hash) { page = hash; remember = false }
  else {
    try { page = localStorage.getItem('whalepet.panel.page') || 'overview' } catch { /* 从第一页开始 */ }
  }
  go(page, remember)

  api.onUsage(snap => {
    state.snapshot = snap
    renderOverview()
    renderSource()
  })
}

boot()
