// 「动作什么时候播」的纯逻辑自测（不启动 Electron）
//
//   node tools/test-triggers.js
//
// 验的是「用户把胶囊挪来挪去」之后，存下来的那份名单还对不对：
//   时机表 -> 默认名单 -> 收拾（丢掉不存在的动作 / 去重 / 补缺）
//   增 / 删 / 排序 -> 再收拾
//
// 这一层以前是 main.js 里的一段 switch（动作自带 slot，改不了），所以没得测；
// 抽成 shared/triggers.js 之后它成了纯数据运算，能用假的动作表把每种改法走一遍。
// 最要紧的一条是**「显式空名单」不能被默认值填回来** —— 用户清空一个时机之后
// 重启，它要是自己长回来，用户只会觉得「设置了不生效」。
'use strict'

let pass = 0
let fail = 0

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  -> ' + extra : '')) }
}

const T = require('../shared/triggers.js')

/* 假的动作表：形状和 main.js 的 ACTIONS 一样（id / slot=默认时机 / def / weight）。
 * 用假的而不是真的，是因为这个文件测的是**规则**，不是「傻鱼这套素材里有哪些动作」。 */
const ACTIONS = [
  { id: 'blink', slot: 'blink' },
  { id: 'acting', slot: 'idle', weight: 3 },
  { id: 'hips', slot: 'idle', weight: 3 },
  { id: 'revive', slot: 'idle', weight: 1 },
  { id: 'happy', slot: 'click' },
  { id: 'hurt-lite', slot: 'hit' },
  { id: 'hurt-mid', slot: 'hit' },
  { id: 'hurt-big', slot: 'hit' },
  { id: 'unused-one', slot: 'idle', def: false },
]

const ids = list => list.join(',')

console.log('\n一、时机表本身')

ok('五个时机：待机随机 / 偶尔眨眼 / 单击摸摸 / 双击 / 扣费反应',
  ids(T.triggerIds()) === 'idle,blink,pet,click,hit', ids(T.triggerIds()))
ok('每个时机都有名字和说明（界面上要显示）',
  T.TRIGGERS.every(t => t.id && t.label && t.desc))
ok('只有「扣费反应」是有序的（顺序 = 轻重分档）',
  T.TRIGGERS.filter(t => t.ordered).map(t => t.id).join(',') === 'hit',
  T.TRIGGERS.filter(t => t.ordered).map(t => t.id).join(','))
ok('isOrdered(hit) 为真', T.isOrdered('hit') === true)
ok('isOrdered(idle) 为假', T.isOrdered('idle') === false)
ok('不存在的时机 isOrdered 为假（不抛）', T.isOrdered('nope') === false)
ok('getTrigger 认得出、认不出返回 null',
  !!T.getTrigger('hit') && T.getTrigger('nope') === null)

console.log('\n二、默认名单：动作自己声明的 slot 就是它的默认时机')

const def = T.defaultTriggers(ACTIONS)
ok('待机随机 = 三个小动作', ids(def.idle) === 'acting,hips,revive', ids(def.idle))
ok('偶尔眨眼 = 眨眼', ids(def.blink) === 'blink', ids(def.blink))
ok('双击 = 开心', ids(def.click) === 'happy', ids(def.click))
ok('扣费反应 = 三档，且从轻到重（按动作表顺序）',
  ids(def.hit) === 'hurt-lite,hurt-mid,hurt-big', ids(def.hit))
ok('单击摸摸默认借最轻的两档扣费反应',
  ids(def.pet) === 'hurt-lite,hurt-mid', ids(def.pet))
ok('def:false 的动作一个名单都不进',
  T.usage(def).has('unused-one') === false)
ok('默认名单覆盖了除 def:false 之外的所有动作',
  T.usedCount(def, ACTIONS) === ACTIONS.length - 1, String(T.usedCount(def, ACTIONS)))

console.log('\n三、老配置换算：actions 开关 -> triggers 名单')

ok('没配过 actions -> 全默认', ids(T.fromLegacy(undefined, ACTIONS).idle) === 'acting,hips,revive')
ok('空对象 actions -> 全默认（等于没改过）', ids(T.fromLegacy({}, ACTIONS).idle) === 'acting,hips,revive')
ok('关掉「双手叉腰」-> 它从待机随机里消失',
  ids(T.fromLegacy({ hips: false }, ACTIONS).idle) === 'acting,revive',
  ids(T.fromLegacy({ hips: false }, ACTIONS).idle))
ok('关掉「轻痛」-> 它从扣费反应和单击摸摸里**都**消失',
  T.fromLegacy({ 'hurt-lite': false }, ACTIONS).hit.indexOf('hurt-lite') < 0
  && T.fromLegacy({ 'hurt-lite': false }, ACTIONS).pet.indexOf('hurt-lite') < 0)
ok('显式打开的（true）不动',
  ids(T.fromLegacy({ hips: true }, ACTIONS).idle) === 'acting,hips,revive')
ok('关掉一个不存在的动作 -> 安然无事',
  ids(T.fromLegacy({ '早就不在了': false }, ACTIONS).idle) === 'acting,hips,revive')

console.log('\n四、收拾配置（normalizeTriggers）：丢掉不存在的、去重、补缺')

const messy = T.normalizeTriggers({
  idle: ['acting', 'acting', '已经删掉的动作', 'hips'],
  hit: ['hurt-big'],
  // blink / pet / click 三个键压根没写 -> 走默认
}, ACTIONS)
ok('重复的动作只留一个', ids(messy.idle) === 'acting,hips', ids(messy.idle))
ok('配置里已经不存在的动作被丢掉', messy.idle.indexOf('已经删掉的动作') < 0)
ok('写过的键按写的来', ids(messy.hit) === 'hurt-big', ids(messy.hit))
ok('没写过的键回落默认', ids(messy.blink) === 'blink' && ids(messy.click) === 'happy')
ok('非字符串的项也不会漏进去（脏数据不炸）',
  ids(T.normalizeTriggers({ idle: [1, null, 'hips'] }, ACTIONS).idle) === 'hips')

// 这一条是整个模块最容易写错的地方，单独拎出来
const cleared = T.normalizeTriggers({ pet: [] }, ACTIONS)
ok('**显式清空的时机不会被默认值填回来**（空数组 != 没配过）',
  ids(cleared.pet) === '', ids(cleared.pet))
ok('清空一个时机不影响别的时机', ids(cleared.hit) === 'hurt-lite,hurt-mid,hurt-big', ids(cleared.hit))

console.log('\n五、改名单：加 / 删 / 排序')

let cur = T.normalizeTriggers(null, ACTIONS)
ok('起点是全默认', ids(cur.idle) === 'acting,hips,revive')

cur = T.addAction(cur, 'idle', 'unused-one', ACTIONS)
ok('加一个动作进去', ids(cur.idle) === 'acting,hips,revive,unused-one', ids(cur.idle))
cur = T.addAction(cur, 'idle', 'unused-one', ACTIONS)
ok('加同一个动作两次不会重复', ids(cur.idle) === 'acting,hips,revive,unused-one', ids(cur.idle))
cur = T.addAction(cur, 'idle', '不存在的动作', ACTIONS)
ok('加一个不存在的动作 -> 原样（不炸）', ids(cur.idle) === 'acting,hips,revive,unused-one', ids(cur.idle))
cur = T.addAction(cur, '不存在的时机', 'hips', ACTIONS)
ok('往不存在的时机里加 -> 原样（不炸）', ids(cur.idle) === 'acting,hips,revive,unused-one', ids(cur.idle))

cur = T.removeAction(cur, 'idle', 'hips', ACTIONS)
ok('从某个时机里去掉一个动作', ids(cur.idle) === 'acting,revive,unused-one', ids(cur.idle))
ok('去掉之后它确实「没在用」了吗？这里没有 —— 它还在别的时机里吗？不是，所以算没在用',
  T.usage(cur).has('hips') === false)

// 同一个动作可以同时挂在几个时机上（默认的「轻痛」就是），去掉一处不能影响另一处
let both = T.normalizeTriggers(null, ACTIONS)
ok('去掉扣费反应里的 hurt-lite，单击摸摸里的它还在',
  T.removeAction(both, 'hit', 'hurt-lite', ACTIONS).pet.indexOf('hurt-lite') >= 0)
ok('反过来也一样',
  T.removeAction(both, 'pet', 'hurt-lite', ACTIONS).hit.indexOf('hurt-lite') >= 0)

let ord = T.normalizeTriggers(null, ACTIONS)
ord = T.moveAction(ord, 'hit', 'hurt-big', -1, ACTIONS)
ok('有序名单里上移一位', ids(ord.hit) === 'hurt-lite,hurt-big,hurt-mid', ids(ord.hit))
ord = T.moveAction(ord, 'hit', 'hurt-big', -1, ACTIONS)
ok('再上移一位到顶', ids(ord.hit) === 'hurt-big,hurt-lite,hurt-mid', ids(ord.hit))
ord = T.moveAction(ord, 'hit', 'hurt-big', -1, ACTIONS)
ok('已经在顶上再上移 -> 原样（不越界）', ids(ord.hit) === 'hurt-big,hurt-lite,hurt-mid', ids(ord.hit))
ord = T.moveAction(ord, 'hit', 'hurt-mid', 1, ACTIONS)
ok('已在末尾再下移 -> 原样', ids(ord.hit) === 'hurt-big,hurt-lite,hurt-mid', ids(ord.hit))
ok('排序只动传进来的那一份时机',
  ids(T.moveAction(T.normalizeTriggers(null, ACTIONS), 'hit', 'hurt-big', -1, ACTIONS).idle)
  === 'acting,hips,revive')

console.log('\n六、和默认比：一模一样的就不用写进 config.json')

ok('全默认 -> isDefault 为真（config 里存 null）',
  T.isDefault(null, ACTIONS) === true)
ok('收拾过但没改过内容的，也算默认（顺序相同）',
  T.isDefault(T.defaultTriggers(ACTIONS), ACTIONS) === true)
ok('删掉一个动作 -> 不再是默认',
  T.isDefault(T.removeAction(T.defaultTriggers(ACTIONS), 'idle', 'hips', ACTIONS), ACTIONS) === false)
ok('只把两个动作换个顺序 -> 不再是默认（顺序也算）',
  T.isDefault({ ...T.defaultTriggers(ACTIONS), idle: ['hips', 'acting', 'revive'] }, ACTIONS) === false)
ok('顺序换回来 -> 又是默认',
  T.isDefault({ ...T.defaultTriggers(ACTIONS), idle: ['acting', 'hips', 'revive'] }, ACTIONS) === true)

console.log('\n七、统计：在用几个 / 谁没用上')

const tr = T.normalizeTriggers(null, ACTIONS)
ok('默认状态下「在用」= 除 def:false 外的全部',
  T.usedCount(tr, ACTIONS) === 8 && ACTIONS.length === 9, T.usedCount(tr, ACTIONS) + '/' + ACTIONS.length)
ok('没安排时机的那条只列出 unused-one', ids(T.unused(tr, ACTIONS)) === 'unused-one', ids(T.unused(tr, ACTIONS)))
ok('同一个动作挂两处也只算「在用」一次（单击摸摸借的那两个）',
  T.usage(tr).get('hurt-lite') === 2 && T.usedCount(tr, ACTIONS) === 8,
  'hurt-lite 出现 ' + T.usage(tr).get('hurt-lite') + ' 次')
ok('把某个动作从所有时机里清掉 -> 它进「没安排时机」',
  ids(T.unused(T.setList(tr, 'hit', [], ACTIONS), ACTIONS)).includes('hurt-big'))

console.log('\n八、不许再往回长（反向断言）')

ok('时机表里没有第二个「有序」的（顺序只有扣费反应需要）',
  T.TRIGGERS.filter(t => t.ordered).length === 1)
ok('模块不再导出「每个动作一个开关」那套 API（on/off 已经并进名单了）',
  T.setAction === undefined && T.isActionOn === undefined && T.actionDefault === undefined)
ok('份数对得上：每个时机都有一份名单（不会漏画一张卡片）',
  T.triggerIds().every(id => Array.isArray(tr[id])))

console.log('')
if (fail === 0) console.log('通过 ' + pass + ' 项，全部通过')
else console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exit(fail === 0 ? 0 : 1)
