# 用量插件编写说明

放一个 `.js` 文件就能给桌宠加一个用量来源。

| 目录 | 谁放的 | 设置里的操作 |
| --- | --- | --- |
| `<应用目录>/providers/` | 随应用分发 | 可**卸载 / 安装**；文件不能删（删了下次更新又回来） |
| `~/.whalepet/providers/` | 你自己 | 同上，另外可以**删除文件** |

放好后右键桌宠 →「设置…」→「重载插件」即可，**不用重启**。

> **下划线开头的文件不会被加载。** `_template.js`（骨架）、`_wip.js`（写到一半）都靠这个规则搁着。
> 想临时停用一个插件，把文件名前面加个 `_` 就行。

## 最小可用示例

最省事的做法是把 `providers/_template.js` 复制出来改。下面是为了读懂契约压缩过的版本：

```js
// ~/.whalepet/providers/mytool.js
'use strict'

const RECENT_MS = 3 * 24 * 60 * 60 * 1000
const BLANK = () => ({ tokens: 0, calls: 0 })

const meta = {
  id: 'mytool',                    // 全局唯一；和内置插件重名会覆盖内置
  label: 'MyTool',
  vendor: '我自己写的 CLI',
  badge: 'MY',                     // 设置里的角标，2~3 个字符
  unit: 'token',                   // 面板上显示时用的单位：'token' / 'credit'（积分）/ 'CNY'
  paths: ['~/.mytool/logs'],       // 设置里展示「读哪里」
  desc: '读 ~/.mytool/logs/*.jsonl 里的 usage 行',
  fields: [{ id: 'mytool', label: 'MyTool 今日', unit: 'token' }],
  // 受击阈值 [[下限, 档位], ...]，从高到低。档位只能是 weak / normal / critical。
  //
  // 单位就是**你自己 emit 的那个量纲**（token / 元 / 积分），编排层不做任何换算 ——
  // 所以按「你这个来源单笔大概多少」来填：token 来源常见 1~8 万，人民币来源 0.004~0.012，
  // 积分来源 0.1 上下。不写就用默认（>= 1 算 normal）。
  damage: [[60000, 'critical'], [20000, 'normal']],
}

function create(api) {
  const { num, parseIso } = api

  const state = {
    tails: new api.TailSet(),   // 管一批文件的增量读，并区分「历史」和「新到」
    dayKey: 0,
    today: BLANK(),
    seen: new Set(),
    available: false,
    detail: '',
  }

  function poll(now, emit) {
    const files = api.walkFiles(api.expand('~/.mytool/logs'), {
      name: /\.jsonl$/i,
      sinceMs: RECENT_MS,
    })
    state.available = files.length > 0
    if (!state.available) { state.detail = '没找到日志'; return }

    // 北京时间跨 00:00 自动清零当日累计
    const day = api.rollDay(now, state, () => { state.today = BLANK(); state.seen.clear() })

    for (const { line, history } of state.tails.read(files.map(f => f.file))) {
      let rec
      try { rec = JSON.parse(line) } catch { continue }
      if (!rec) continue

      const at = parseIso(rec.timestamp) || now
      if (api.bjDayKey(at) !== day) continue

      const id = String(rec.id || at)
      if (state.seen.has(id)) continue
      state.seen.add(id)

      const tokens = num(rec.totalTokens)
      state.today.tokens += tokens
      state.today.calls += 1

      // history=true 是**首轮读到的历史账**，只累计、不发事件。
      // 忘了这个判断，桌宠每次启动都会为旧记录放一串受击动画。
      if (!history) emit({ source: meta.id, amount: tokens, unit: 'token', at, id })
    }

    state.detail = files.length + ' 个文件 · 今日 ' + state.today.calls + ' 次'
  }

  return {
    get available() { return state.available },
    get detail() { return state.detail },
    poll,
    // raw() 的数字会被「今日已用」汇总字段读走：
    //   todayTokens 进 token 合计，todayCredit 进积分合计（没有就不填）。
    raw(now) {
      return { available: state.available, todayTokens: state.today.tokens, callsToday: state.today.calls }
    },
    // fields() 把数据变成信息条上的文字。label 是暗色小字，value 是亮色数字，
    // unit 会渲染成数字后面的小字（「5.47 积分」）。tone: '' / off / warn / danger / peak / valley
    //
    // 惯例：**没有数据时只画 `--`，unit 一起收起来**。`-- token` 里的单位是噪音，
    // 而且所有内置插件都按这条来，别做那个例外。
    fields(now, ctx) {
      const has = state.available && state.today.calls > 0
      return [{
        id: 'mytool',
        label: 'MyTool 今日',
        value: has ? ctx.fmtTokens(state.today.tokens) + ' · ' + state.today.calls + ' 次' : '--',
        unit: has ? 'token' : '',
        tone: has ? '' : 'off',
        title: '鼠标悬停在信息条上时的完整明细',
      }]
    },
  }
}

module.exports = { meta, create }
```

## 约定

**`create(api)` 返回的对象**必须有 `poll(now, emit)` 和 `fields(now, ctx)`，另外建议提供
`available` / `detail`（设置里显示成「可用 / 无数据」和一行细节）以及 `raw(now)`
（面板里的样例数据 + 「今日已用」合计）。

> 字段 id 是**全局**的：`fields()` 里返回的 `id` 就是写在 `usage.json` 里的那个 id，
> 也是「桌宠上显示」列表里的那个。让插件 id 给字段 id 当前缀最省事（`mytool` / `mytool-cost`）。

**`api` 里有什么**

| 成员 | 说明 |
| --- | --- |
| `fs` / `os` / `path` | 原样透传的模块，省得你猜模块解析路径 |
| `HOME` | 用户主目录 |
| `expand(p)` | 把 `~/xxx` 展开成绝对路径 |
| `walkFiles(root, opt)` | 递归找文件；`opt` 支持 `name`（正则）、`sinceMs`（只留最近改过的）、`maxFiles`、`maxDepth` |
| `Tailer(file)` | 增量读**单个**文件的追加内容，`.drain()` 返回新出现的完整行 |
| `TailSet` | 增量读**一批**文件；`.read(files)` 逐行给你 `{ line, history, file }`，并自动清理已消失的文件 |
| `rollDay(now, state, onNewDay)` | 北京时间跨天时调 `onNewDay()` 并返回今天的 `dayKey`，配合 `bjDayKey(at) !== day` 过滤 |
| `hasNodeSqlite()` / `sqliteQuery(dbPath, sql)` | 只读查一个 SQLite 库。**异步**返回行数组，任何失败都给你 `null`。本进程（Electron 33 / Node 20）没有 `node:sqlite`，所以它去借 WorkBuddy 自带的 Node 起一次性子进程；借不到就 `null`，你自己降级 |
| `bjDayKey(ts)` / `bjTodayStart(ts)` | UTC 毫秒 → 北京时间的 `YYYYMMDD` 整数 / 今天 00:00 的 UTC 毫秒 |
| `parseIso(s)` / `num(v)` | ISO-8601 → UTC 毫秒 / 转数字（非法值给 0） |
| `UNIT_LABEL` / `withUnit(v, unit)` | 单位显示名映射 / 拼「值 + 单位」（不想自己拼的时候用） |

**`ctx` 里有什么**（`fields()` 用）

| 成员 | 说明 |
| --- | --- |
| `ctx.fmtTokens(n)` | `131072` → `13.1万` |
| `ctx.fmtAmount(n)` | `0.5231` → `0.523`，`8.8712` → `8.87` |
| `ctx.ctxLimit` | 上下文窗口上限（默认 300000，`WHALEPET_CTX_LIMIT` 可改） |
| `ctx.balance` | DeepSeek 余额状态（`{supported, value, currency, available, error}`） |

**`emit(ev)` 的字段**：`{ source, amount, unit, at, id }`，其余字段随便加（会一起传给渲染端）。
平台做两件事：拿 `amount` 和 `meta.damage` 比出受击**档位**（weak / normal / critical），
再把 `amount` + `unit` 排版成鱼身上那句 `-多少`。**渲染端只认这两样**，不做任何业务判断，
也不做任何换算 —— 至于这个档位播哪一段动作，是用户在设置面板里排的「扣费反应」名单，
和你无关，也不用管。

`unit` 就是你报账用的量纲，原样呈现给用户：

| `unit` | 鱼身上飘出来的样子 | 典型来源 |
| --- | --- | --- |
| `'credit'` | `-0.09 积分` | WorkBuddy |
| `'CNY'` | `-¥0.004` | DSH / 手动记账 |
| `'token'` | `-1.2万 token` | Codex / Claude / ZCode |

所以你**在 `emit` 里如实报 `amount`**，桌面上「用多少扣多少」就自动对得上 —— 平台不折价、
不累计，也**没有**任何单价配置项。`meta.unit`（面板上显示用）和 `emit` 里的 `unit`
可以是两回事：DSH 面板上按 token 显示，但它 `emit` 的是 `unit: 'CNY'` 的 `cost`，
所以它飘出来的就是人民币。

一轮里你可能 `emit` 很多笔（一次落盘几十条记录很正常）—— **不用自己合计，也不该合计**：
平台会一笔一笔如实呈现（渲染端把它们排成队挨个飘出来）。你少报一笔，桌面上就少一个数字。

## 必须遵守的两条

1. **只读。** 插件不该写任何文件、不该改别人的目录。桌宠会在你的 `poll` 外面包 try/catch，
   但抛异常仍然意味着这一轮你什么都没采到。
2. **首轮不发事件。** 第一次读会把历史全读进来算「今日合计」，如果这时也 `emit`，
   桌宠一启动就会连着放一串受击动画。用 `TailSet.read()` 给的 `history`（或自己维护
   `tailer.armed`）：第一次读完再置真。

## 加一个插件不需要改别的文件

`usage.js` 里**没有**任何按来源 id 写死的表：

| 你想做的事 | 写在哪 |
| --- | --- |
| 受击阈值（单位 = 你自己 `emit` 的量纲） | `meta.damage` |
| 信息条上能勾哪些字段 | `meta.fields` |
| 数字后面的单位（积分 / token / ¥） | `meta.unit` + `fields()` 里的 `unit` |
| 鱼身上飘的数字与单位 | `emit()` 里的 `amount` + `unit` |
| 进「今日已用」合计 | `raw()` 里的 `todayTokens` / `todayCredit` |
| 设置里显示「读哪里」 | `meta.paths` |

所以新插件一装好就自动出现在设置里、自动有单位后缀、自动进「今日已用」、扣费时自动
飘出它自己的金额，界面上一个像素都不用改。

## 排错

插件加载失败不会让桌宠变砖，错误会出现在设置窗口「数据源插件」底部的红条里（语法错、缺
`meta`、`create` 抛异常都会写在那里），对应的卡片会显示「装载失败」。

想更快定位可以用命令行：

```powershell
node tools\test-providers.js                              # 看插件装没装、读到了什么
$env:WHALEPET_TEST_DAY="2026-09-29"; node tools\test-providers.js   # 时间旅行到某天，验证解析本身
```

`$env:WHALEPET_TEST_DAY` 会把 `Date.now` 拨到那天的 12:00（北京时间）再装载插件 ——
这样验的是**解析逻辑对不对**，而不是「今天恰好有没有用量」。
