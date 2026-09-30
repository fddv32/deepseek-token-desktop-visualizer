// 动作的「什么时候播」—— 动作是一张表，时机是另一张表，中间用一份份**名单**连起来。
//
// 以前每个动作在 ACTIONS 里写死一个 slot：眨眼只能眨眼，双击只能开心。想换个搭配
// 只能改代码，用户那边只有一个开关。现在把「动作是什么」和「什么时候播」拆开：
//
//   动作   main.js 的 ACTIONS        —— 有哪些动画、素材在哪、每帧停多久
//   时机   这里的 TRIGGERS           —— 什么时候会播；每个时机带一份**有序**的动作名单
//   配置   config.json 的 triggers   —— 时机 -> 名单，用户改的就是这一份
//
// 于是「双击播哪个」不再是代码里的约定，而是名单里放了谁；想换，把胶囊挪一格就行。
// 同一个动作也可以同时出现在几个时机上（默认的「轻痛」既在单击摸摸、也在扣费反应
// —— 这一版形象没有专门的「被摸」素材，所以是借的）。
//
// 而「一个动作不在任何名单里」本身就是关掉它，所以不再单存一份开关：
// 两套状态迟早会打架（关掉了却还在名单里 / 开着却没人播）。
//
// 这个文件只做纯数据运算，不碰 fs、不碰 electron，所以 node 能直接 require 来测。
'use strict'

/**
 * 时机表。
 *
 *   ordered 名单的顺序有没有意义。只有「扣费反应」有：金额算出来的轻重是分档的
 *           （轻 / 中 / 重），第 N 档就取名单里第 N 个动作，所以顺序 = 轻重顺序。
 *           其余时机都是一个池子，随机挑，顺序只影响界面上怎么排。
 *   desc    界面上跟在名字后面的一句话 —— 用户判断「放这里会怎样」的唯一线索。
 *
 * 数组顺序 = 设置面板上的显示顺序：从「没人管的时候」到「你动手」到「账进来了」。
 */
const TRIGGERS = [
  { id: 'idle', label: '待机随机', desc: '闲着的时候按权重随机挑一个' },
  { id: 'blink', label: '偶尔眨眼', desc: '它自己的节拍，两三秒眨一下' },
  { id: 'pet', label: '单击摸摸', desc: '左键单击时随机挑一个' },
  { id: 'click', label: '双击', desc: '左键双击时播' },
  { id: 'hit', label: '扣费反应', desc: '每笔账到账时播；从上到下 = 从轻到重', ordered: true },
]

/**
 * 「单击摸摸」默认借几个扣费反应。这一版形象没有单独的「被摸」素材，
 * 摸一下的反馈就是轻微地抖一下 —— 所以默认借最轻的两档，而不是留空。
 * 用户想改成别的（或者干脆不要）在设置里挪一下就行。
 */
const PET_BORROWS = 2

function triggerIds() {
  return TRIGGERS.map(t => t.id)
}

function getTrigger(id) {
  return TRIGGERS.find(t => t.id === id) || null
}

/** 这个时机的名单有没有顺序含义（有 = 界面上给它排序按钮）。 */
function isOrdered(id) {
  const t = getTrigger(id)
  return !!(t && t.ordered)
}

/**
 * 全默认的名单：**动作自己声明的 slot 就是它的默认时机**。
 *
 * 这是这套模型里唯一一处「动作自带时机」—— 只用来生成初始值，生成完就归用户了。
 * 加一个新动作时顺手在 ACTIONS 里写一行 slot，它就会出现在对的时机里，
 * 不用再来这个文件里登记一次。
 */
function defaultTriggers(actions) {
  const out = {}
  for (const t of TRIGGERS) out[t.id] = []
  for (const a of actions || []) {
    if (a.def === false) continue // 默认关掉的动作：不进任何名单
    if (out[a.slot]) out[a.slot].push(a.id)
  }
  // 借最轻的几档给「单击摸摸」。hit 名单是按轻重排的，所以取前几个就是最轻的。
  if (out.hit.length > 0) out.pet = out.hit.slice(0, Math.min(PET_BORROWS, out.hit.length))
  return out
}

/**
 * 把配置里存的那份收拾干净，并补上缺的时机。
 *
 * 三件事：丢掉已经不存在的动作（换了形象 / 删了素材）、去重、缺的时机回落到默认。
 *
 * 注意「显式空名单」和「没配过」是两回事：`{ pet: [] }` 是「单击时不要任何反应」，
 * 必须原样留着；只有**这个键根本不在**的时候才回落默认。所以判据是
 * `Array.isArray` 而不是 `list.length`—— 少这一条，用户把某个时机清空之后
 * 一重启它就自己长回来了。
 */
function normalizeTriggers(raw, actions) {
  const known = new Set((actions || []).map(a => a.id))
  const def = defaultTriggers(actions)
  const out = {}
  for (const t of TRIGGERS) {
    const list = raw ? raw[t.id] : null
    if (!Array.isArray(list)) { out[t.id] = def[t.id].slice(); continue }
    const picked = []
    for (const id of list) {
      if (typeof id !== 'string' || !known.has(id) || picked.indexOf(id) >= 0) continue
      picked.push(id)
    }
    out[t.id] = picked
  }
  return out
}

/**
 * 老配置的 `actions: { id: false }` 换算到名单上 —— 只在读旧 config.json 时走一次。
 *
 * 以前是「每个动作一个开关」，现在是「每份名单里放谁」，两套不能并存：留着两份状态
 * 迟早出现「关掉了却还在播」这种说不清的情况。所以换算完就把 actions 丢掉。
 *
 * 换算就是「先取全默认名单，再把明确关掉过的动作从每份名单里摘掉」。
 */
function fromLegacy(actions, list) {
  let t = defaultTriggers(list)
  if (actions && typeof actions === 'object') {
    for (const id of Object.keys(actions)) {
      if (actions[id] === false) {
        for (const k of Object.keys(t)) t[k] = t[k].filter(x => x !== id)
      }
    }
  }
  return t
}

/** 两份名单是不是一模一样（顺序也算）。判断「和默认一致」用。 */
function sameTriggers(a, b) {
  for (const t of TRIGGERS) {
    const x = (a && a[t.id]) || []
    const y = (b && b[t.id]) || []
    if (x.length !== y.length) return false
    for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return false
  }
  return true
}

/** 配置里的这份是不是就等于全默认 —— 等于就不必写进 config.json。 */
function isDefault(raw, actions) {
  return sameTriggers(normalizeTriggers(raw, actions), defaultTriggers(actions))
}

/** 替换某个时机的整份名单。返回收拾干净的新名单（调用方只管存）。 */
function setList(triggers, slot, ids, actions) {
  if (!getTrigger(slot)) return normalizeTriggers(triggers, actions)
  return normalizeTriggers({ ...triggers, [slot]: Array.isArray(ids) ? ids : [] }, actions)
}

/** 往某个时机加一个动作（已经在里面就原样返回，不重复）。 */
function addAction(triggers, slot, id, actions) {
  const next = normalizeTriggers(triggers, actions)
  if (!getTrigger(slot) || !next[slot] || next[slot].indexOf(id) >= 0) return next
  return setList(next, slot, next[slot].concat([id]), actions)
}

/** 从某个时机去掉一个动作。（同一个动作可能还在别的时机里，那不影响。） */
function removeAction(triggers, slot, id, actions) {
  const next = normalizeTriggers(triggers, actions)
  if (!next[slot]) return next
  return setList(next, slot, next[slot].filter(x => x !== id), actions)
}

/**
 * 在某个时机里把动作上移 / 下移一位。
 *
 * 只有有序的时机（扣费反应）界面上会露出这两个按钮：那里的顺序 = 轻重分档，
 * 排错了就是「小额扣费播暴击」，是能看见的错。别的时机顺序不影响播放，不露按钮
 * 也就少一排噪音。
 */
function moveAction(triggers, slot, id, delta, actions) {
  const next = normalizeTriggers(triggers, actions)
  const list = next[slot]
  if (!list) return next
  const from = list.indexOf(id)
  const to = from + (delta < 0 ? -1 : 1)
  if (from < 0 || to < 0 || to >= list.length) return next
  const moved = list.slice()
  moved.splice(from, 1)
  moved.splice(to, 0, id)
  return setList(next, slot, moved, actions)
}

/** 动作 id -> 它被放进了几个时机。用来算「在用几个」以及谁完全没用上。 */
function usage(triggers) {
  const count = new Map()
  for (const t of TRIGGERS) {
    for (const id of (triggers && triggers[t.id]) || []) {
      count.set(id, (count.get(id) || 0) + 1)
    }
  }
  return count
}

/** 一个动作都没放进去的那些动作 id（按传入顺序）。 */
function unused(triggers, actions) {
  const count = usage(triggers)
  return (actions || []).filter(a => !count.has(a.id)).map(a => a.id)
}

/** 至少被放进一个时机的动作数。 */
function usedCount(triggers, actions) {
  const count = usage(triggers)
  return (actions || []).filter(a => count.has(a.id)).length
}

module.exports = {
  TRIGGERS,
  PET_BORROWS,
  triggerIds,
  getTrigger,
  isOrdered,
  defaultTriggers,
  normalizeTriggers,
  fromLegacy,
  sameTriggers,
  isDefault,
  setList,
  addAction,
  removeAction,
  moveAction,
  usage,
  unused,
  usedCount,
}
