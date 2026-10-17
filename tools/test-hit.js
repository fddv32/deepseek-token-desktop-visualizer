// 扣费口径的纯逻辑自测（不启动 Electron）
//
//   node tools/test-hit.js
//
// 验的是「一笔账 -> 显示成什么 + 算多重 + 一轮怎么合并」这条链：
//   平台只做两件事 —— 把这一笔排版成一句「-多少」，以及按插件声明的阈值定受击**档位**。
//   不换算、不累计、不折算成任何统一量纲，所以这里也不该出现「合计 / 胖瘦 / 单价」型的断言，
//   第六节那几条反向断言会在有人偷偷加回去时先响。
//
// 只读不写：不碰 usage.json，也不碰任何日志目录（poll 只是被顺带跑一遍）。
'use strict'

let pass = 0
let fail = 0

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  -> ' + extra : '')) }
}

function near(a, b, eps) {
  return Math.abs(Number(a) - Number(b)) <= (eps === undefined ? 1e-9 : eps)
}

try {
  const usage = require('../usage.js')

  console.log('\n一、数字格式 fmtHit（小额必须看得见）')
  ok("0 -> '0'", usage.fmtHit(0) === '0')
  ok("负数 -> '0'", usage.fmtHit(-3) === '0')
  ok("非数字 -> '0'", usage.fmtHit('abc') === '0')
  ok("0.004 -> '0.004'（DSH 一笔就这个量级）", usage.fmtHit(0.004) === '0.004')
  ok("0.09 -> '0.09'（WorkBuddy 单条中位数）", usage.fmtHit(0.09) === '0.09')
  ok("0.5 -> '0.5'（尾巴上的零要去掉）", usage.fmtHit(0.5) === '0.5')
  ok("1.7 -> '1.7'（实测单条最大）", usage.fmtHit(1.7) === '1.7')
  ok("12.345 -> '12.35'", usage.fmtHit(12.345) === '12.35')
  ok("150.5 -> '150.5'", usage.fmtHit(150.5) === '150.5')
  ok("1200 -> '1200'", usage.fmtHit(1200) === '1200')
  ok("0.001 -> '0.001'", usage.fmtHit(0.001) === '0.001')
  ok("0.0006 -> '0.0006'（token 源一次 6 万 token 的掉血）", usage.fmtHit(0.0006) === '0.0006')
  ok("0.00012 -> '0.00012'（12 万 token 折算后不留一串 0）", usage.fmtHit(0.00012) === '0.00012')
  ok("0.00001 -> '0.00001'", usage.fmtHit(0.00001) === '0.00001')
  ok("1e-9 -> '<0.000001'（再小就认了，不印一串 0）", usage.fmtHit(1e-9) === '<0.000001')

  console.log('\n二、一笔账排版成什么 hitOf（量纲不同，先归一成「掉多少血」）')
  ok("credit 0.09 -> '0.09' + 积分", (() => {
    const h = usage.hitOf(0.09, 'credit')
    return h.hitValue === '0.09' && h.hitUnit === '积分'
  })())
  ok("CNY 0.004 -> '¥0.004'（自带货币符号，不再缀单位；DSH 用余额口径）", (() => {
    const h = usage.hitOf(0.004, 'CNY')
    return h.hitValue === '¥0.004' && h.hitUnit === ''
  })())
  ok("CNY 1.25 -> '¥1.25'", usage.hitOf(1.25, 'CNY').hitValue === '¥1.25')
  ok("token 12000 -> '0.00012' + 积分（1 百万 token = 0.01 点血）", (() => {
    const h = usage.hitOf(12000, 'token')
    return h.hitValue === '0.00012' && h.hitUnit === '积分'
  })())
  ok("token 60000 -> '0.0006'", usage.hitOf(60000, 'token').hitValue === '0.0006')
  ok("token 800 -> '0.000008'", usage.hitOf(800, 'token').hitValue === '0.000008')
  ok("100 万 token -> 正好 0.01 点血", usage.bloodOf(1e6, 'token') === 0.01,
    String(usage.bloodOf(1e6, 'token')))
  ok("积分 / 人民币的掉血都不折算（1:1）",
    usage.bloodOf(3.5, 'credit') === 3.5 && usage.bloodOf(1.25, 'CNY') === 1.25)
  ok('受击档位**不**跟着掉血换算走（还是按各来源自己的量纲）',
    usage.damageLevel(60000, [[60000, 'critical'], [20000, 'normal']]) === 'critical')
  ok('三种量纲的文案互不相同（不可能被混成一句）',
    usage.hitOf(1, 'credit').hitValue !== usage.hitOf(1, 'CNY').hitValue)
  ok("未知量纲退回 token 口径（兜底不抛异常）", usage.hitOf(1500, 'whatever').hitUnit === '积分')

  console.log('\n三、受击档位：拿**这个来源自己的量纲**比阈值（给的是档位，不是动作名）')
  const wbD = [[0.5, 'critical'], [0.1, 'normal']]
  ok('WorkBuddy：0.09 积分 -> weak（低于 0.1）', usage.damageLevel(0.09, wbD) === 'weak')
  ok('WorkBuddy：0.1 积分 -> normal', usage.damageLevel(0.1, wbD) === 'normal')
  ok('WorkBuddy：0.5 积分 -> critical', usage.damageLevel(0.5, wbD) === 'critical')
  const dshD = [[0.012, 'critical'], [0.004, 'normal']]
  ok('DSH：¥0.004 -> normal', usage.damageLevel(0.004, dshD) === 'normal')
  ok('DSH：¥0.012 -> critical', usage.damageLevel(0.012, dshD) === 'critical')
  ok('DSH：¥0.002 -> weak', usage.damageLevel(0.002, dshD) === 'weak')
  const tokD = [[60000, 'critical'], [20000, 'normal']]
  ok('token 源：6万 -> critical', usage.damageLevel(60000, tokD) === 'critical')
  ok('token 源：2万 -> normal', usage.damageLevel(20000, tokD) === 'normal')
  ok('token 源：300 -> weak', usage.damageLevel(300, tokD) === 'weak')
  ok('没有阈值表的插件走默认档（>=1 normal）', usage.damageLevel(1, null) === 'normal')
  ok('没有阈值表 + 小于 1 -> weak', usage.damageLevel(0.3, null) === 'weak')

  // 这一节的要点：**档位不是动作名**。以前这里返回的 'pain-weak' 之类正好也是动作
  // id，于是「多大的账播哪一段」被焊死在代码里。现在这里只说轻重，播哪段由用户在
  // 设置里排的名单决定，所以档位名里不许再出现动作的名字。
  ok('档位就三档，从轻到重',
    JSON.stringify(usage.TIERS) === JSON.stringify(['weak', 'normal', 'critical']),
    JSON.stringify(usage.TIERS))
  ok("老插件里写的 'pain-normal' 还认得（用户自己写的插件不该因内部改名而失灵）",
    usage.tierOf('pain-normal') === 'normal', usage.tierOf('pain-normal'))
  ok("老写法 'pain-weak' 也认", usage.tierOf('pain-weak') === 'weak', usage.tierOf('pain-weak'))
  ok('认不出来的名字落到 normal（不崩，也不假装成「轻」）',
    usage.tierOf('瞎写的') === 'normal', usage.tierOf('瞎写的'))

  console.log('\n四、一轮的账**逐笔**配文案 decorateEvents（不合并、不累计）')
  const one = usage.decorateEvents([
    { source: 'workbuddy', amount: 0.3, unit: 'credit', at: 100, id: 'a', level: 'normal' },
    { source: 'workbuddy', amount: 0.1, unit: 'credit', at: 200, id: 'b', level: 'normal' },
    { source: 'workbuddy', amount: 0.1, unit: 'credit', at: 300, id: 'c', level: 'normal' },
  ])
  ok('3 笔还是 3 条（没有并成一条）', one.length === 3, String(one.length))
  ok("第一条是 '0.3'、第二条是 '0.1'（金额没被加到一起）",
    one[0].hitValue === '0.3' && one[1].hitValue === '0.1',
    one.map(x => x.hitValue).join(' / '))
  ok('每条都带自己的单位', one.every(x => x.hitUnit === '积分'))
  ok('每条都保留自己的 id / at（能对上账本）', one[1].id === 'b' && one[1].at === 200)
  ok('每条都带着主进程定好的受击档位', one.every(x => x.level === 'normal'))

  const mixed = usage.decorateEvents([
    { source: 'workbuddy', amount: 0.09, unit: 'credit', at: 100, level: 'weak' },
    { source: 'dsh', amount: 0.004, unit: 'CNY', at: 200, level: 'normal' },
    { source: 'codex', amount: 12000, unit: 'token', at: 300, level: 'weak' },
  ])
  ok('三种量纲各是各的，不会加成一个没有意义的数', mixed.length === 3, String(mixed.length))
  ok("credit 那条是 '0.09' + 积分", mixed[0].hitValue === '0.09' && mixed[0].hitUnit === '积分')
  ok("CNY 那条是 '¥0.004'（不带小字单位）", mixed[1].hitValue === '¥0.004' && mixed[1].hitUnit === '')
  ok("token 那条是 '0.00012' + 积分（已经折成血）",
    mixed[2].hitValue === '0.00012' && mixed[2].hitUnit === '积分',
    mixed[2].hitValue + '/' + mixed[2].hitUnit)
  ok('空输入 -> 空输出', usage.decorateEvents([]).length === 0)
  ok('没有 unit 的事件兜底按 token 走（不炸）',
    usage.decorateEvents([{ amount: 5000, at: 1 }])[0].unit === 'token')
  ok('金额缺失 / 非法也不会抛（给一个 0 文案，渲染端会跳过它）',
    usage.decorateEvents([{ at: 1, unit: 'credit' }])[0].hitValue === '0')

  console.log('\n五、eventOf：伪扣费（WHALEPET_FAKE_HIT）和真实扣费同一套口径')
  const ev = usage.eventOf('workbuddy', 3.5, 'credit')
  ok('amount=3.5 credit -> 文案 3.5', ev.hitValue === '3.5', ev.hitValue)
  ok('单位是积分', ev.hitUnit === '积分', ev.hitUnit)
  ok('同上一笔 -> 暴击（>=0.5）', ev.level === 'critical', ev.level)
  const dshEv = usage.eventOf('dsh', 0.012, 'CNY')
  ok("DSH 那笔 -> '¥0.012' + 暴击", dshEv.hitValue === '¥0.012' && dshEv.level === 'critical',
    dshEv.hitValue + '/' + dshEv.level)
  ok('不传 unit 时取插件自己的 meta.unit', usage.eventOf('workbuddy', 0.2).hitUnit === '积分')
  ok('事件里的 level 是三档之一（档位），不是动作名',
    usage.eventOf('workbuddy', 3.5, 'credit').level === 'critical'
    && usage.eventOf('workbuddy', 0.3, 'credit').level === 'normal'
    && usage.eventOf('workbuddy', 0.05, 'credit').level === 'weak')

  console.log('\n六、按费用构成拆账 + 连击（照 dsh-damage-pulse 的「缓存感知扣血」）')
  const dshProv = require('../providers/dsh')
  const n = v => Number(v) || 0
  const split = dshProv.costParts(
    { cost: 0.0239, costInput: 0.001, costCacheRead: 0.0026, costOutput: 0.0203 }, n)
  ok('一笔账拆成 3 条（未命中 / 命中 / 输出）', split.length === 3, JSON.stringify(split))
  ok('未命中缓存 = 最重那一档（它付的是全价输入）',
    split[0].kind === 'input' && split[0].level === 'critical' && split[0].label === '未命中')
  ok('命中缓存 = 中档', split[1].kind === 'cache' && split[1].level === 'normal' && split[1].label === '命中')
  ok('输出 = 轻档（单价最高但量小，插件原口径就是 severity 1）',
    split[2].kind === 'output' && split[2].level === 'weak' && split[2].label === '输出')
  ok('拆出来的金额之和 == 整笔 cost（账面不会被拆多或拆少）',
    near(split.reduce((a, p) => a + p.cost, 0), 0.0239, 1e-9),
    String(split.reduce((a, p) => a + p.cost, 0)))
  ok('没有分项字段时退回整笔（不能漏掉这次扣费）',
    (p => p.length === 1 && p[0].cost === 0.5 && p[0].level === 'normal')(dshProv.costParts({ cost: 0.5 }, n)))
  ok('金额为 0 的账一条都不发', dshProv.costParts({ cost: 0 }, n).length === 0)
  ok('缓存写入单独一条（也是轻档）',
    (p => p.length === 1 && p[0].kind === 'write' && p[0].level === 'weak')(
      dshProv.costParts({ cost: 0.002, costCacheWrite: 0.002 }, n)))

  const labeled = usage.decorateEvents([{ amount: 0.001, unit: 'CNY', label: '未命中' }])[0]
  ok('拆出来的那条把「未命中」排在小字里', labeled.hitUnit === '未命中', labeled.hitUnit)
  ok('积分来源同样能带后缀',
    usage.decorateEvents([{ amount: 3, unit: 'credit', label: '命中' }])[0].hitUnit === '积分 · 命中')
  ok('没有 label 时小字为空（原有行为不变）',
    usage.decorateEvents([{ amount: 0.004, unit: 'CNY' }])[0].hitUnit === '')

  ok('连击窗口是 900ms（和插件一致）', usage.COMBO_WINDOW_MS === 900, String(usage.COMBO_WINDOW_MS))
  const oldNow = Date.now
  Date.now = () => 0
  usage.markCombo(0, 'critical')                       // 清掉上一次（时间回到 0）
  ok('第一击不算连击', usage.markCombo(10000, 'critical') === false)
  ok('400ms 后又一记重击 -> 连击', usage.markCombo(10400, 'critical') === true)
  ok('隔了 2s 就不算连击了', usage.markCombo(12400, 'critical') === false)
  ok('轻击不参与连击判定（也不重置窗口）', usage.markCombo(12410, 'weak') === false)
  Date.now = oldNow

  console.log('\n七、扣费实时 + 余额 60 秒校准（照 dsh-damage-pulse：扣费先逐笔减、余额再对齐）')
  ok('采集周期压到 1s（扣费要实时）', usage.POLL_MS === 1000, String(usage.POLL_MS))
  ok('余额校准周期是 60s', usage.BALANCE_INTERVAL_MS === 60000, String(usage.BALANCE_INTERVAL_MS))
  ok('周期可被 WHALEPET_USAGE_MS 覆盖（费电的机器能调回去）',
    /WHALEPET_USAGE_MS/.test(String(require('fs').readFileSync(require('path').join(__dirname, '..', 'usage.js'), 'utf8'))))
  ok('只有 DSH 的人民币花费会实时减余额',
    usage.countsTowardBalance(0.02, 'CNY', 'dsh') === true
    && usage.countsTowardBalance(3, 'credit', 'workbuddy') === false
    && usage.countsTowardBalance(50000, 'token', 'claude') === false
    && usage.countsTowardBalance(0, 'CNY', 'dsh') === false)
  ok('显示余额 = 官方校准值 − 实时扣掉的', usage.liveBalanceOf(10, 0.027) === 9.973)
  ok('没校准过就不显示（null，而不是 0）', usage.liveBalanceOf(null, 1) === null)
  ok('扣到负数夹到 0（官方返回 0 / 欠费时不显示负余额）', usage.liveBalanceOf(0.01, 0.5) === 0)
  const balSnap = usage.poll().snapshot.dsh.balance
  ok('快照里同时有官方值和实时值（渲染端判断充值必须用官方值）',
    'value' in balSnap && 'live' in balSnap && 'spentSince' in balSnap, JSON.stringify(balSnap))
  ok('刚校准完两个值相等（spentSince 归零）',
    balSnap.spentSince !== 0 || balSnap.live === balSnap.value, JSON.stringify(balSnap))

  console.log('\n八、不记账：平台里不该再有米粒 / 单价 / 胖瘦（反向断言）')
  const snap = usage.poll().snapshot
  ok('快照里没有 grains 累计块', snap.grains === undefined, JSON.stringify(snap.grains))
  ok('信息条字段里没有「今日米粒」', !snap.fields.some(f => f.id === 'grains'),
    snap.fields.map(f => f.id).join(' / '))
  ok('可选字段表里也没有它（不然用户还能勾回来）',
    !usage.fieldCatalog().some(f => f.id === 'grains'),
    usage.fieldCatalog().map(f => f.id).join(' / '))
  const cfg = usage.publicConfig()
  ok('配置里没有 prices / 单价', cfg.prices === undefined, JSON.stringify(cfg.prices))
  ok('配置里没有 satiety / 吃饱线', cfg.satiety === undefined)
  ok('配置里没有 grainsPerCredit', cfg.grainsPerCredit === undefined)
  ok('设置面板要的插件清单里不再有 price 字段',
    usage.listProviders().providers.every(p => p.price === undefined && p.priceLabel === undefined))
  ok('导出里不再有 toGrains / riceCount / setPrice',
    usage.toGrains === undefined && usage.riceCount === undefined && usage.setPrice === undefined)
  ok('也不再有「合并成一笔」的 coalesceEvents（改成逐笔的 decorateEvents）',
    usage.coalesceEvents === undefined && typeof usage.decorateEvents === 'function')
} catch (err) {
  fail++
  console.log('  ✗ 抛异常：' + ((err && err.stack) || err))
}

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exit(fail === 0 ? 0 : 1)
