// 设置窗口渲染端
//
// 刻意的分工：**所有「显示成什么字」都在主进程算好**（usage.js 的 fields），
// 这里只负责把 fields 数组画出来。这样桌宠信息条和这个预览图不可能出现两套格式 ——
// 之前踩过的坑就是同一个百分比在两个地方各写一遍，改了一处忘了另一处。
//
// 同一个道理也用在插件上：这里的「可用 / 已卸载 / 装载失败」全部来自主进程的
// listProviders()，前端不做任何状态推断。
'use strict'

window.addEventListener('error', ev => {
  console.error('[settings] uncaught: ' + ev.message + ' @ ' + ev.filename + ':' + ev.lineno)
})

/* ---------- 建 DOM 的小工具 ---------- */

/**
 * h('div', { class: 'x', text: 'y', onclick: fn }, kid, kid…)
 *
 * 这个面板整屏都是「几十个 createElement + appendChild」，写三两个还行，写上两百行
 * 就只剩噪音、看不出结构了。抽一个出来，渲染函数才回到「结构」本身。
 * 约定：值为 null / undefined / false 的属性直接跳过 —— 这样才能写
 * `it.vendor ? h(...) : null` 这种可选片段。
 * 键名带连字符的（data-* / aria-*）走 setAttribute：直接 `el['data-x'] = v` 只会
 * 挂一个同名的 JS 属性，元素上并没有那个 attribute，`querySelector('[data-x=…]')`
 * 和 `dataset.x` 都读不到 —— 这个坑踩过一次。
 */
function h(tag, props, ...kids) {
  const el = document.createElement(tag)
  for (const k of Object.keys(props || {})) {
    const v = props[k]
    if (v == null || v === false) continue
    if (k === 'class') el.className = v
    else if (k === 'text') el.textContent = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k.indexOf('-') >= 0) el.setAttribute(k, v === true ? '' : String(v))
    else el[k] = v
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid)
  return el
}

const $ = id => document.getElementById(id)

/** 面板状态：主进程下发的三份数据 + 最近一帧用量（按字段 id 索引）。 */
const state = {
  app: null,        // 外观：大小 / 形象 / 置顶
  usage: null,      // 字段配置 + 可选字段表
  providers: null,  // 插件清单
  byId: new Map(),  // 字段 id -> 最近一帧的渲染值
}
/** 字段 id -> 那一行右侧「当前值」的 span，用来原地改字，避免每 2.5s 重建整列表。 */
const curEls = new Map()
let busy = false

/* ---------- 轻提示 ---------- */

const toastEl = h('div', { id: 'toast' })
document.body.append(toastEl)
let toastTimer = null

function toast(msg) {
  toastEl.textContent = msg
  toastEl.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200)
}

/* ---------- 左侧导航：一栏一项，一项一页 ---------- */

/**
 * 为什么是页而不是「一页往下滚」：五段里只有一段是你现在要看的，剩下四段都在
 * 滚动条底下 —— 想改「动作」得先滚过整个字段列表。拆成页之后点谁看谁。
 *
 * 页与导航项都靠 data-page / id 对上，渲染端只认 PAGES 这一个顺序表：
 * 加一页 = 加一个 <section id="page-x"> + 一个 <button data-page="x">，
 * 这个文件里只多一个字符串。
 */
const PAGES = ['look', 'fields', 'actions', 'plugins', 'about']
const PAGE_KEY = 'whalepet.settings.page'

function showPage(id) {
  const page = PAGES.indexOf(id) >= 0 ? id : PAGES[0]
  for (const b of document.querySelectorAll('.nav-item')) {
    const on = b.dataset.page === page
    b.classList.toggle('on', on)
    b.setAttribute('aria-current', on ? 'true' : 'false')
  }
  for (const s of document.querySelectorAll('.page')) {
    s.classList.toggle('on', s.id === 'page-' + page)
  }
  // 翻页时把滚动位置归零。所有页共用 main 这一个滚动容器，不归零的话
  // 从很长的插件列表切回只有三行的外观，会停在半空中看着像内容丢了。
  document.querySelector('main').scrollTop = 0
  try { localStorage.setItem(PAGE_KEY, page) } catch { /* 隐私模式等写不进去，不影响使用 */ }
}

document.querySelector('.nav').addEventListener('click', e => {
  const b = e.target.closest('.nav-item')
  if (b) showPage(b.dataset.page)
})

/** 上次看的是哪一页。设置窗口是常开常关的，「还在插件页」比每次弹回外观顺手。 */
function startPage() {
  try {
    const saved = localStorage.getItem(PAGE_KEY)
    if (saved && PAGES.indexOf(saved) >= 0) return saved
  } catch { /* 读不到就从第一页开始 */ }
  return PAGES[0]
}

/* ---------- 渲染：外观 ---------- */

function renderAppearance() {
  const a = state.app
  if (!a) return

  for (const b of $('scale').querySelectorAll('button')) {
    b.classList.toggle('on', Math.abs(Number(b.dataset.scale) - a.scale) < 0.001)
  }
  $('scale-hint').textContent = '当前 ' + Math.round(a.scale * 100) + '%'

  const skins = $('skins')
  skins.textContent = ''
  for (const s of a.skins) {
    skins.append(h('button', {
      class: 'chip-pick' + (s.id === a.skin ? ' on' : ''),
      title: s.desc || '',
      onclick: () => run(() => window.settings.setSkin(s.id)),
    }, s.label, s.desc ? h('span', { class: 'd', text: s.desc }) : null))
  }

  $('ontop').checked = a.alwaysOnTop
  $('version').textContent = 'v' + a.version
  // 导航栏底那条版本：和「关于」页里那个是同一个值，只是位置不同。
  // 只印版本号 —— 栏顶的 brand 已经写着名字了，这里再来一遍反而挤。
  $('nav-ver').textContent = 'v' + a.version
  const cur = a.skins.find(s => s.id === a.skin)
  $('cur-skin').textContent = '当前形象：' + (cur ? cur.label : a.skin)
}

/* ---------- 渲染：动作 ---------- */

/**
 * 动作页是**按时机分组**画的：一个时机一张卡片，卡片里就是它现在的名单。
 *
 * 为什么不再按动作平铺（原来是 8 行、每行一个开关 + 一句时机说明）：用户真正要
 * 回答的问题是「双击的时候会播什么」。平铺的列表得先把 8 行扫一遍、再从每行右侧
 * 那行小字里找「双击」两个字，改的时候还得在两行之间来回看。分组之后，这个问题
 * 的答案就是那张卡片本身，改也是在答案上改。
 *
 * 数据整份来自主进程（main.js 的 actionState()）：有哪些动作能用、每个时机里放了谁、
 * 谁一个时机都没进。这个文件只负责画和发请求，不做任何判断 —— 所以「支持哪些动作」
 * 永远和实际素材一致。
 *
 * 只有 `ordered` 的时机（扣费反应）露排序按钮：那里的顺序 = 轻重分档，排错了就是
 * 「小额扣费播暴击」，是看得见的错。别的时机随机挑，顺序不影响播放，多一排箭头
 * 只是噪音。
 */
function renderActions() {
  const app = state.app
  if (!app || !app.actions) return
  const data = app.actions
  const box = $('actions')
  box.textContent = ''

  const catalog = data.catalog || []
  // 一张动作素材都没扫到：说清楚是素材的问题，而不是画一堆空卡片让人以为软件坏了
  if (catalog.length === 0) {
    box.append(h('span', { class: 'hint', text: '这个形象没有扫到动作素材' }))
    $('action-count').textContent = ''
    return
  }
  const labelOf = id => (catalog.find(x => x.id === id) || { label: id }).label
  const descOf = id => (catalog.find(x => x.id === id) || {}).desc || ''

  for (const t of data.triggers || []) {
    const ids = t.ids || []
    const body = h('div', { class: 'trig-body' })

    if (ids.length === 0) {
      body.append(h('span', { class: 'trig-empty', text: '空着 —— 这个时机不会播任何动作' }))
    }

    ids.forEach((id, i) => {
      body.append(h('span', { class: 'act-chip' + (t.ordered ? ' ord' : ''), title: descOf(id) },
        // 序号只对有序时机有意义（1 = 最轻的那档）
        t.ordered ? h('i', { class: 'rank', text: String(i + 1) }) : null,
        h('button', {
          class: 'nm',
          text: labelOf(id),
          title: '点一下：让桌面上的桌宠立刻演一次',
          onclick: () => previewAction({ id, label: labelOf(id) }),
        }),
        t.ordered ? h('button', {
          class: 'mv', text: '↑', title: '往上挪一位（更轻的那档）',
          disabled: i === 0,
          onclick: () => moveIn(t.id, ids, id, -1),
        }) : null,
        t.ordered ? h('button', {
          class: 'mv', text: '↓', title: '往下挪一位（更重的那档）',
          disabled: i === ids.length - 1,
          onclick: () => moveIn(t.id, ids, id, 1),
        }) : null,
        h('button', {
          class: 'x', text: '×',
          title: '从这个时机里去掉（它还在别的时机里的话，那边不受影响）',
          onclick: () => run(() => window.settings.setTrigger(t.id, ids.filter(x => x !== id))),
        })))
    })

    // 「加动作」的下拉只列**还没在这个时机里**的动作 —— 列上已经有的，
    // 选中也是一次空操作，白让人点一下。
    const rest = catalog.filter(x => ids.indexOf(x.id) < 0)
    if (rest.length > 0) {
      const sel = h('select', { class: 'act-add', title: '选一个加进这个时机' },
        h('option', { value: '', text: '＋ 加动作' }),
        rest.map(x => h('option', { value: x.id, text: x.label, title: x.desc || '' })))
      sel.addEventListener('change', e => {
        const id = e.target.value
        if (!id) return
        e.target.value = ''
        run(() => window.settings.setTrigger(t.id, ids.concat([id])))
      })
      body.append(sel)
    }

    box.append(h('div', { class: 'trig', 'data-trigger': t.id },
      h('div', { class: 'trig-head' },
        h('b', { class: 'trig-name', text: t.label }),
        h('span', { class: 'trig-desc', text: t.desc }),
        h('span', { class: 'grow' }),
        h('span', { class: 'trig-n', text: ids.length ? ids.length + ' 个' : '空' })),
      body))
  }

  // 没排进任何时机的动作：不是坏了，是「还没给它安排出场的时候」。
  // 单独列一条，否则它就从界面上消失了，用户只会觉得「这动作怎么没了」。
  const unused = (data.unused || []).map(labelOf)
  box.append(h('p', { class: 'trig-unused' },
    h('b', { text: '没安排时机：' }),
    h('span', { class: 'nm', text: unused.length ? unused.join('、') : '（没有）' }),
    unused.length ? h('span', { class: 'dim', text: ' —— 加进上面任一时机它就会开始播' }) : null))

  $('action-count').textContent = data.total ? data.used + '/' + data.total : ''
}

/** 有序时机里把某个动作上/下挪一位。传的是整份新顺序，主进程只管存。 */
function moveIn(slot, ids, id, delta) {
  const from = ids.indexOf(id)
  const to = from + delta
  if (from < 0 || to < 0 || to >= ids.length) return
  const next = ids.slice()
  next.splice(from, 1)
  next.splice(to, 0, id)
  run(() => window.settings.setTrigger(slot, next))
}

/** 试演：不改配置，只让桌宠播一次。连点会把动画反复打断，所以限一下频。 */
let previewAt = 0

async function previewAction(it) {
  const now = Date.now()
  if (now - previewAt < 400) return
  previewAt = now
  let res = null
  try {
    res = await window.settings.previewAction(it.id)
  } catch (err) {
    toast('试演失败：' + ((err && err.message) || err))
    return
  }
  if (res && res.ok) toast('试演：' + it.label)
  else toast((res && res.message) || '试演失败')
}

/* ---------- 渲染：信息条预览 ---------- */

/**
 * 预览按**当前配置的顺序**画，每个字段的 label / value / unit / tone 则用主进程算好的
 * 那一份 —— 顺序是本地的、格式是主进程的，各管各的，不会打架。
 *
 * 「本地配置里有、主进程快照里还没有」的字段画成灰色的 `--` 占位（见下面 fields 那段）：
 * 主进程的快照最长要 2.5s 才轮到，缺了这一步就会「刚点完 ＋ 预览没反应」。
 */
function renderPreview() {
  const cfg = state.usage
  if (!cfg) return
  // 第一帧快照还没到时 byId 是空的 —— 先留空，别急着喊「你没选字段」
  if (state.byId.size === 0) return
  const cat = new Map((cfg.catalog || []).map(f => [f.id, f]))
  // 顺序一律按本地配置（cfg.fields）来，快照里查不到的补一个占位 pill。
  //
  // 为什么要补：state.byId 只由主进程推来的快照填，而快照要等下一轮 poll（最长 2.5s）
  // 才会带上刚加的字段。早先这里写的是 .filter(Boolean)，于是刚点完 ＋ 预览纹丝不动、
  // 过两秒才突然冒出来，看着像没点上 —— 顺序修好了，但「新字段根本不在」没修。
  //
  // 占位**不带单位**：插件们在没有数据时都是只画 `--`（见各 provider 的 fields()），
  // 预览的职责是「预告信息条长什么样」，多印一个单位就和实拍对不上了。
  const fields = cfg.fields.map(id => {
    const hit = state.byId.get(id)
    if (hit) return hit
    const meta = cat.get(id) || { id, label: id }
    return { id, label: meta.label || id, value: '--', unit: '', tone: 'off', title: meta.desc || '' }
  })
  if (fields.length === 0) Pills.empty($('preview'), '还没有选择字段 —— 桌宠上将不显示信息条')
  else Pills.render($('preview'), fields)
}

/* ---------- 渲染：字段列表 ---------- */

function opBtn(text, title, disabled, onClick) {
  return h('button', { class: 'icon-btn', text, title, disabled, onclick: onClick })
}

function renderFields() {
  const cfg = state.usage
  if (!cfg) return
  const catalog = new Map((cfg.catalog || []).map(f => [f.id, f]))
  const last = cfg.fields.length - 1

  const on = $('field-on')
  on.textContent = ''
  curEls.clear()
  cfg.fields.forEach((id, i) => {
    const meta = catalog.get(id) || { id, label: id }
    const cur = h('span', { class: 'cur', text: state.byId.has(id) ? String(state.byId.get(id).value) : '—' })
    curEls.set(id, cur)
    on.append(h('div', { class: 'field-row', title: meta.desc || '' },
      h('span', { class: 'ord', text: String(i + 1) }),
      h('span', { class: 'nm', text: meta.label || id },
        meta.providerLabel ? h('span', { class: 'own', text: meta.providerLabel }) : null),
      // 这个字段此刻在信息条上的实际值：不用切回桌面也能确认选对了没有
      cur,
      h('span', { class: 'ops' },
        opBtn('↑', '上移', i === 0, () => move(i, -1)),
        opBtn('↓', '下移', i === last, () => move(i, 1)),
        opBtn('×', '从信息条移除', false, () => applyFields(cfg.fields.filter(x => x !== id))))))
  })

  if (cfg.fields.length === 0) {
    on.append(h('div', { class: 'chips' },
      h('span', { class: 'none', text: '信息条将隐藏。从下面挑几个字段加回来。' })))
  }

  // 未启用字段
  const off = $('field-off')
  off.textContent = ''
  const rest = (cfg.catalog || []).filter(f => !cfg.fields.includes(f.id))
  if (rest.length === 0) off.append(h('span', { class: 'none', text: '全部字段都已显示' }))
  for (const f of rest) {
    off.append(h('button', {
      class: 'chip-add',
      text: '＋ ' + (f.label || f.id) + (f.providerLabel ? '（' + f.providerLabel + '）' : ''),
      title: f.desc || '',
      onclick: () => applyFields([...cfg.fields, f.id]),
    }))
  }

  $('field-count').textContent = cfg.fields.length ? cfg.fields.length + ' 项' : '未显示'
}

function move(index, delta) {
  const ids = state.usage.fields.slice()
  const to = index + delta
  if (to < 0 || to >= ids.length) return
  ;[ids[index], ids[to]] = [ids[to], ids[index]]
  applyFields(ids)
}

/* ---------- 渲染：插件列表 ---------- */

/** 状态点 / 文案。装载失败和「装了但本机没数据」要分开 —— 后者不是故障。 */
function statusOf(p) {
  if (!p.installed) return ['no', '已卸载']
  if (!p.loaded) return ['err', '装载失败']
  return p.available ? ['ok', '可用'] : ['no', '无数据']
}

function pluginCard(p) {
  const [tone, statusText] = statusOf(p)
  const ops = h('span', { class: 'acts' })
  ops.append(h('button', {
    class: p.installed ? 'uninstall' : 'install',
    text: p.installed ? '卸载' : '安装',
    title: p.installed ? '卸载：不再读取这个来源，字段从信息条摘掉（文件保留）' : '安装：重新读取这个来源',
    onclick: () => install(p, !p.installed),
  }))
  if (!p.builtin) {
    ops.append(h('button', {
      class: 'danger',
      text: '删除文件',
      title: '把 ' + String(p.file).split(/[\\/]/).pop() + ' 从用户插件目录删掉，不可撤销',
      onclick: () => removeFile(p),
    }))
  }

  return h('div', { class: 'plugin ' + (p.installed ? 'on' : 'off') },
    h('div', { class: 'top' },
      h('span', { class: 'badge', text: p.badge || '·' }),
      h('div', { class: 'names' },
        h('div', { class: 'name', text: p.label }),
        p.vendor ? h('div', { class: 'vendor', text: p.vendor }) : null),
      h('span', { class: 'grow' }),
      h('span', { class: 'tag' + (p.userLevel ? ' user' : ''), text: p.userLevel ? '用户插件' : '内置' }),
      ops),
    h('div', { class: 'meta' },
      h('span', { class: 'dot ' + tone }),
      h('span', { class: 'st-' + tone, text: statusText }),
      p.detail ? h('span', { text: ' · ' + p.detail }) : null),
    p.paths && p.paths.length
      ? h('div', { class: 'paths' }, h('span', { text: '读取' }), ...p.paths.map(x => h('code', { text: x })))
      : null,
    p.desc ? h('div', { class: 'desc', title: p.desc, text: p.desc }) : null)
}

function renderProviders() {
  const d = state.providers
  if (!d) return
  const box = $('providers')
  box.textContent = ''
  for (const p of d.providers) box.append(pluginCard(p))

  $('plugin-count').textContent = d.providers.filter(p => p.installed).length + '/' + d.providers.length

  renderAboutSources()

  const errs = d.errors || []
  const el = $('plugin-errors')
  el.textContent = ''
  el.classList.toggle('hidden', errs.length === 0)
  if (errs.length) {
    el.append(h('b', { text: '有 ' + errs.length + ' 个插件没加载成功：' }))
    for (const e of errs) {
      el.append(h('div', { text: '· ' + String(e.file).split(/[\\/]/).pop() + ' —— ' + e.message }))
    }
  }
}

/* ---------- 渲染：关于里的数据源清单 ---------- */

function renderAboutSources() {
  const d = state.providers
  if (!d) return
  const box = $('about-sources')
  box.textContent = ''
  for (const p of d.providers) {
    const [tone, text] = statusOf(p)
    box.append(h('div', { class: 'source' + (p.installed ? '' : ' off') },
      h('span', { class: 'b', text: p.badge || '·' }),
      h('span', { class: 'nm', text: p.label }),
      h('span', { class: 'p', text: (p.paths || []).join('、'), title: p.desc || '' }),
      h('span', { class: 'st ' + tone, text })))
  }
}

/* ---------- 状态同步 ---------- */

function setBusy(v) {
  busy = v
  document.body.style.cursor = v ? 'progress' : ''
}

/**
 * 把主进程回来的结果并进状态。
 * 所有会改配置的 IPC 都返回同一个形状 `{ app?, usage?, providers? }`，
 * 所以这里只写一遍 —— 前端不需要知道「哪个操作会动哪一块」。
 */
function absorb(res) {
  if (!res) return null
  if (res.app) state.app = res.app
  if (res.usage) state.usage = res.usage
  if (res.providers) state.providers = res.providers
  renderAppearance()
  renderActions()
  renderFields()
  renderProviders()
  renderPreview()
  return res
}

/** 跑一次会改配置的 IPC。busy 期间挡住重复点击（连点 × 会连发好几轮重渲染）。 */
async function run(fn) {
  if (busy) return null
  setBusy(true)
  try {
    return absorb(await fn())
  } catch (err) {
    toast('操作失败：' + ((err && err.message) || err))
    return null
  } finally {
    setBusy(false)
  }
}

const applyFields = ids => run(() => window.settings.setFields(ids))
const install = (p, on) => run(() => window.settings.setInstalled(p.id, on))
  .then(res => { if (res) toast((on ? '已安装 ' : '已卸载 ') + p.label) })

/** 删文件单独走一路：失败时要弹提示，成功也要说一声。 */
async function removeFile(p) {
  if (busy) return
  setBusy(true)
  let res = null
  try {
    res = await window.settings.deleteFile(p.id)
  } catch { /* 下面统一提示 */ }
  setBusy(false)
  if (res && res.ok) {
    toast('已删除 ' + p.label)
    absorb(res)
  } else {
    toast((res && res.message) || '删除失败')
    absorb(res)
  }
}

/* ---------- 预览与「当前值」随桌面上的实时数据更新 ---------- */

window.settings.onUsage(snap => {
  state.byId = new Map((snap && snap.fields ? snap.fields : []).map(f => [f.id, f]))
  renderPreview()
  // 字段行右侧那列「当前值」原地改字。不重建整列表：这份快照每 2.5 秒来一次，
  // 重建会让 hover 高亮和 title 浮层一直闪。
  for (const [id, el] of curEls) {
    const f = state.byId.get(id)
    const text = f ? String(f.value) : '—'
    if (el.textContent !== text) el.textContent = text
  }
})

/* ---------- 交互绑定 ---------- */

$('scale').addEventListener('click', e => {
  const b = e.target.closest('button[data-scale]')
  if (b) run(() => window.settings.setScale(Number(b.dataset.scale)))
})

$('ontop').addEventListener('change', e => {
  run(() => window.settings.setAlwaysOnTop(e.target.checked))
})

$('btn-reload').addEventListener('click', async () => {
  if (await run(() => window.settings.reloadProviders())) toast('已重新扫描插件目录')
})

$('btn-dir').addEventListener('click', async () => {
  const res = await window.settings.openPluginsDir()
  if (res && res.dir) toast(res.error ? '打不开：' + res.error : '已打开 ' + res.dir)
})

/* ---------- 启动 ---------- */

// 先定页再拉数据：页是纯 DOM 状态，不等 IPC；否则窗口会先闪一下「外观」再跳到上次那页。
showPage(startPage())

async function refresh() {
  setBusy(true)
  try {
    absorb(await window.settings.load())
  } catch (err) {
    toast('读取配置失败：' + ((err && err.message) || err))
  } finally {
    setBusy(false)
  }
}

refresh()
