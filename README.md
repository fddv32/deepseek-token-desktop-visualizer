# 鲸鱼娘桌宠（WhalePet）

> 会看 token 消耗的桌面宠物。底部常驻一条信息条，实时汇总你所有 AI 客户端的用量，每笔扣费都变成一次受击动画。

独立 Windows 桌宠程序，克隆或解压到任意目录，双击即用。除了会动，它还把 **token 消耗变成看得见的反应**：底部常驻一条信息条，实时汇总你所有 AI 客户端的用量——**WorkBuddy、DSH、Codex、Claude Code、ZCode 五个数据源开箱即用**；显示哪几项、按什么顺序显示，都在**设置窗口**里勾选。每笔扣费到账，鲸鱼娘按金额轻重受击（轻痛 → 普通痛 → 暴击）。

**单位口径**：WorkBuddy 计的是 credit，桌面上按**积分**显示；其余来源（DSH / Codex / Claude / ZCode）一律按 **token** 显示。信息条上还有一个可选的「**今日已用**」汇总字段，把今天各来源的量并排放在一起（token 和积分分开记，**不做汇率式换算**）。某一格**没有数据时不带单位**、只画 `--` —— `-- token` 里的单位纯是噪音。

数据源和字段都是**插件**：想接自己的客户端，把 `providers/_template.js` 复制成 `~/.whalepet/providers/xxx.js` 就多一个数据源；不想要的，在设置里**卸载**（内置插件随时装回来），用户级插件还能直接**删除文件**。查询思路参考了 [iFence/TokenMonitor](https://github.com/iFence/TokenMonitor)（只借鉴"读本地会话日志、不算网络请求"的做法，代码是重写的）。

素材来自 [dsh-damage-pulse](https://github.com/wssfk12138/dsh-damage-pulse) 插件的鲸鱼娘帧图，交互设计参考 [LorisYounger/VPet](https://github.com/LorisYounger/VPet)（虚拟桌宠模拟器）。

## 启动

```powershell
git clone https://github.com/<你的用户名>/whale-pet.git
cd whale-pet
```

然后**双击 `安装依赖.bat`** 装一次依赖（走 npmmirror 镜像），之后**双击 `启动鲸鱼娘桌宠.bat`** 即可，秒开。

目录放在哪儿都行（D 盘、桌面、任意路径），两个脚本都用 `%~dp0` 取自己的位置。

依赖缺失时（比如 `node_modules` 被删了），启动脚本会主动提示你双击 `安装依赖.bat`。

也可以手动启动：

```powershell
npm install
npm start
```

### 启动脚本的两个坑（改脚本前必读）

这两个坑都会让「双击了没反应」，而且报错信息看着和真实原因完全无关：

**① 必须是 GBK 编码 + CRLF 换行。**
中文 Windows 的 CMD 代码页是 936(GBK)。脚本若存成 UTF-8，CMD 会按 GBK 逐字节配对，把下一行的首字符吃掉，于是 `cd /d "%~dp0"` 变成 `锟斤拷d ...`，报 `不是内部或外部命令` + `系统找不到指定的路径`；若再是纯 LF 换行，多行 `if ( ... )` 括号块解析失效，块内命令会被无条件执行。改完请用 `python tools\make-launchers.py` 重新生成。

**② `%~dp0` 结尾自带反斜杠，不能塞进引号。**
`%~dp0` 展开是 `D:\WhalePet\`，写进引号就变成 `"...electron.exe" "D:\WhalePet\"`——反斜杠把结尾引号转义掉了，引号不闭合，Electron 收到的是非法路径 `D:\WhalePet"`，结果是**只挂一个进程、永远不出窗口**（`tasklist` 里能看到 electron.exe，但桌面上什么都没有）。必须先去掉尾斜杠再传参。

## 交互（参考 VPet）

| 操作 | 反应 |
|---|---|
| 待机 | 8 帧待机循环，随机眨眼；偶尔做小动作（acting 8 帧） |
| 左键单击 | 随机摸摸反应：轻疼痛 / 普通疼痛（weak / normal 的 half→close→reopen 节奏） |
| 左键双击 | 开心：闭眼 → 笑眯眯 → 睁眼 |
| 按住拖动 | 跟着光标 1:1 移动，松手回待机并记忆位置 |
| 右键 | 菜单只有三项：**置顶开关 / 设置… / 退出**（桌宠和信息条上都可用） |
| 托盘图标 | 菜单同上（显示 / 设置… / 退出）；左键单击显示 |
| 底部信息条 | 常驻显示你勾选的字段（默认：今日已用 / 上下文 / WB 今日 / DSH 今日）；鼠标悬停显示完整明细；**高度随内容自动增减**（窗口底边不动、顶边向上长）；45 秒无账自动淡出 |
| 设置窗口 | 外观（大小 / 形象 / 置顶）、自选信息条字段与顺序、插件安装与卸载、关于 |
| 模型扣费 | 每笔调用按金额轻重播放受击动画：轻痛 → 普通痛 → 暴击 |

窗口透明、无边框、默认置顶、不占任务栏；位置和大小记忆在 `config.json`。

## 拖动实现（重要）

窗口移动由**主进程**按固定节拍读光标并 `setPosition` 完成，渲染端只在按下/松开各发一次 IPC——移动期间渲染端零 IPC，不会出现「窗口移动比画面提交还快」导致的错位。

实测（`tools\drag-verify.py`，真实鼠标事件 + 逐帧抓屏）：光标移动 216 / -72 px 时窗口位移 **216 / -72**，完全 1:1；拖动全程窗口尺寸恒为 570×630，无漂移。

另一种模式是 CSS `-webkit-app-region: drag`（把移动交给系统），但它在 Windows 上会把这整块区域变成非客户区，网页层收不到鼠标事件，单击/双击/右键菜单都会失效；本项目实测它也并不可靠，因此只作为备选保留。

| 环境变量 | 作用 |
|---|---|
| `WHALEPET_POLL_MS=8` | 调整移动节拍（默认 16ms） |
| `WHALEPET_DRAG_MODE=system` | 换成系统级拖动（`-webkit-app-region: drag`），仅作备选 |
| `WHALEPET_DRAG_POSE=1` | 拖起来时切「拎起帧」。默认关闭：那套 `idle-hands.png` 是双手前伸的俯视姿势，在桌宠尺寸下会被看成两个头 |
| `WHALEPET_SANDBOX=1` | 保留 Chromium 沙箱（默认关闭，见下） |
| `WHALEPET_GPU=1` | 保留硬件加速（默认关闭，见下） |
| `WHALEPET_REPORT=1` | 启动自检：把启动路径、窗口句柄、GPU 状态、渲染端报错写到 `tools/startup-report.json` |
| `WHALEPET_CAPTURE=1` | 截图验证：把**窗口自身**的像素存到 `tools\capture-*.png`（走 `capturePage`，不受 DPI 缩放影响） |
| `WHALEPET_CAPTURE_MS=4000,8000` | 配 `WHALEPET_CAPTURE` 用，did-finish-load 后第 N 毫秒各抓一帧 |

> 用量监控相关（`WHALEPET_USAGE` / `WHALEPET_USAGE_MS` / `WHALEPET_CTX_LIMIT` / `WHALEPET_NO_BALANCE` / `WHALEPET_FAKE_HIT` / `WHALEPET_FAKE_HIT_AT` / `WHALEPET_FAKE_LEVEL` / `WHALEPET_OPEN_SETTINGS`）见下面「用量监控」章节。

### 沙箱与硬件加速（默认都关掉）

这台机器上 Chromium 的渲染沙箱会和宿主环境冲突，表现为 **GPU 进程反复崩溃、Electron 紧接着 FATAL 退出**——现象就是「双击了但什么都没发生」；即使侥幸起来，窗口也是白的。实测结论：

| 沙箱 | 硬件加速 | 结果 |
|---|---|---|
| 开 | 开 | FATAL，进程直接退出 |
| 关 | 开 | 进程活着、页面加载成功，但窗口不显示 |
| 关 | 关 | **正常显示**（当前默认） |

所以 `main.js` 在启动最早期就关掉沙箱并禁用硬件加速。本桌宠只加载本地素材、不访问任何网络页面，关掉沙箱的暴露面很小。如果你的机器显卡正常、想换回默认：设 `WHALEPET_SANDBOX=1 WHALEPET_GPU=1` 再启动。

### 素材说明

`assets/whale-girl` 里顶层的 `*-hands.png`（`idle-hands` / `normal-pain-hands` / `weak-pain-hands` / `heal-happy-hands` / `critical-pain-hands`）在原插件 `dsh-damage-pulse` 的动画清单里**没有被任何一帧引用**，是废弃素材；单独播放时看起来像「两个头」。本桌宠默认不使用它们。

`assets/ciallo/`（「Ciallo～ 贴纸」形象）只有一张原图，46 帧全部由 `tools/make-ciallo-frames.py` 程序化生成（平移 / 缩放 / 旋转 / 挤压 / 染色）。原图是**白底贴纸**，抠图分三步，都在 `tools/make-ciallo-sticker.py` 里：

1. **删字**：按颜色判别 `Ciallo～(∠・ω< )⌒★` 的笔画（蓝灰填充色），再沿笔画量出的下沿做**镜像反射**补回被字挡住的裙摆。这里不能用 inpainting —— 荷叶边是周期性的弧，`INPAINT_TELEA` 会拉出一长条灰白渐变把它抹平。
2. **去白边**：轮廓外本来就画了一圈白描边，缩到桌宠尺寸后是整圈扎眼的光晕。判据要**三条同时成立**：亮度低于墨线阈值才算「可通行」→ 从画面四边洪泛（墨线挡路，进不去角色内部）→ 再限定「离已透明像素不超过 14px」。只用前两条会把**女仆围裙**整片吃掉（42k px vs 正确的 24k px），只用第三条会把**头饰**外沿削掉。
3. **清孤立碎片**：镜像和白边剥离会在正文外留下几十像素的小岛。主分量占 99.9%，按「只留最大连通分量」处理最稳。

改完素材记得**两个工具按顺序都重跑一遍**（贴纸 → 帧），`make-ciallo-frames.py` 里的基准宽是按贴纸实际宽高比算的，不用手改常量。

## 界面

配色全部取自鲸鱼娘本体：藏青（头发 / 裙）、藕荷蓝（蝴蝶结）、冰白（围裙）、金（腰饰）。

**桌宠信息条**是**冰白底 + 藏青字**，不是深色。这是刻意的取舍：桌宠常驻桌面，深底在浅色壁纸上会糊成一块，冰白底配藏青反而哪个壁纸都读得清，也和她身上的围裙是一族。

**设置窗口**是一块浅色的卡片式界面（比她那条信息条亮一档），顶部一道藕荷蓝的圆角横幅，里面分四段：外观、桌宠上显示、数据源插件、关于。左右留白收到 **12px** —— 再宽，卡片两侧会空出一大条白，内容显得「缩在中间」。

信息条和设置里的预览是**同一份**，抽在 `shared/`：

| 文件 | 作用 |
|---|---|
| `shared/pills.css` | `.pillbar`（条容器）+ `.pill` / `.lb` / `.nm` / `.un`（单位小字）+ 语义色（`.t-peak` / `.t-valley` / `.t-warn` / `.t-danger` / `.t-off`） |
| `shared/pills.js` | `Pills.render(box, fields)` / `Pills.empty` / `Pills.key` |

字段的形态是 `{ id, label?, value, unit?, tone?, title? }`：`unit` 会渲染成数字后面的小字（`5.47 积分` / `132.5万 token`），字号更小、颜色更淡 —— 读数字时它不抢眼，需要的时候又在那儿。

两个窗口各写一份 CSS 迟早会漂移（改了颜色只改一处），所以两边 `<link>` / `<script>` 同一个文件。**注意 `pills.css` 要排在 `pet.css` 之前**，让 `pet.css` 能用 id 选择器盖掉「位置」和「存在感」（透明度、hover、pulse）那几行 —— 外观归 shared，位置归自己。

`#usage` 元素本身就带 `.pillbar` 类，没有内层包裹元素；渲染端量到的 `getBoundingClientRect()` 直接就是那条的高度。

## 设置窗口

右键桌宠或信息条 →「设置…」（托盘菜单里也有）。菜单本身只有三项，功能全在这里：

| 分区 | 内容 |
|---|---|
| **外观** | 大小（小 70% / 中 100% / 大 140%）、形象（`assets/` 下每套一个）、窗口置顶 |
| **桌宠上显示** | 实时预览 + 字段行（`↑ ↓ ×` 排序/移除）+「可添加的字段」胶囊 |
| **数据源插件** | 每个来源一张卡片：安装 / 卸载、状态、读取路径、用户插件可删除文件；右上角还有「插件目录」「重载插件」 |
| **关于** | 版本、交互说明、数据源清单（含每家的读取路径）、配置文件位置 |

**改大小不会让桌宠跳动**：`setScale()` 保持**底边不动**、把顶边往上推（和「信息条长高」是同一套做法）；反过来直接改 `height` 会让窗口往下长，桌宠本体跟着掉一截。

**卸载的语义是「不装载它」**：不读它的日志、不占内存、它声明的字段自动从信息条上摘掉。文件不动 —— 内置插件本来就该随时装回来。用户级插件额外有「删除文件」，那才是真的删。手滑卸载了也不用慌：重新安装后字段会回到「可添加的字段」里，但**不会**自作主张塞回信息条（否则排好的顺序会被悄悄改掉）。

## 用量监控（token 消耗可视化）

信息条常驻在桌宠底部，**显示哪些字段、什么顺序可以自己挑**（右键 →「设置…」→ 桌宠上显示）。

### 字段

| 字段 | 单位 | 含义 | 数据来源 |
|---|---|---|---|
| **今日已用** | token + 积分 | 所有**已安装**来源今天的合计，并排显示（`5564.2万 token · 0.520 积分`），悬停有按来源的拆分 | 各插件 `raw()` 里的 `todayTokens` / `todayCredit` |
| 价格时段 | — | 当前是否 DeepSeek 高峰（工作日 09:00–12:00、14:00–18:00；周末全天谷时） | 本地时间 |
| 上下文 | — | WorkBuddy 当前会话的上下文占用 / 上限 | `~/.workbuddy/logs/**/*.log` 的 `[shouldCompact] ... totalTokens=` |
| WB 今日 | **积分** | WorkBuddy 今日累计 credit（悬停里带调用次数） | 同上日志的 `[SessionManager][credit] Credit received: ... credit=` |
| DSH 今日 | token | DSH 插件今日 token / 次数（悬停里带按峰谷价算的 `¥`） | `~/.dsh/data/dsh-token-monitor/usage.jsonl` |
| DeepSeek 余额 | ¥ | 账户余额（联网查一次） | DeepSeek `GET /user/balance` |
| Codex 今日 | token | OpenAI Codex CLI 今日 token / 次数 | `~/.codex/sessions/**/rollout-*.jsonl` 的 `token_usage_record` |
| Claude 今日 | token | Claude Code 今日 token / 次数 | `~/.claude/projects/**/*.jsonl` 的 `assistant` 行 `message.usage` |
| ZCode 今日 | token | ZCode CLI 今日 token / 次数 | `~/.zcode/cli/rollout/model-io-*.jsonl` 的 `response.usage` |

默认显示前四项。鼠标停在信息条上会看到每一项的完整明细（token 数、缓存命中、按模型拆分等）。

**「今日已用」是核心字段，不依赖任何插件**：它只读各插件 `raw()` 里的 `todayTokens` / `todayCredit`，所以以后再装一个插件，它自动就出现在这个合计里，不需要改 `usage.js`。单位不同就不换算 —— 只有 token 就只显示 token，只有积分就只显示积分，两者都有就并排。

顺序就是你排的顺序。用量面板里那个「信息条预览」按**当前配置的顺序**画，但每个字段的文字和颜色仍然是主进程算好的那一份 —— 顺序是本地的、格式是主进程的，各管各的。这样「刚点完 ↑」预览会立刻跟上（不会等下一轮 2.5s 轮询，看着像点了没反应），而数字永远和桌宠上那条一致。

每笔用量到账，按 **等级** 播放受击动画（轻痛 → 普通痛 → 暴击）。等级由主进程按**每个来源各自的量纲阈值**算好后放进事件里，渲染端不做任何业务判断。

阈值**由插件自己在 `meta.damage` 里声明**（`[[下限, 等级], ...]`，从高到低），`usage.js` 不再维护一张按来源 id 写死的表 —— 加插件不用改编排层：

| 来源 | 普通痛起点 | 暴击起点 | 声明在 |
|---|---|---|---|
| WorkBuddy | 1 积分 | 3 积分 | `providers/workbuddy.js` |
| DSH | ¥0.004 | ¥0.012 | `providers/dsh.js` |
| Codex / Claude / ZCode | 2 万 token | 6 万 token | 各自的 `providers/*.js` |
| 不声明 | 1（原值） | — | `usage.js` 的 `DEFAULT_DAMAGE` |

45 秒没有新账，信息条自动淡出到半透明。

### 数据源是插件

每个来源是 `providers/` 下的一个独立模块，可以随时**卸载 / 装回**；用户也能往 `~/.whalepet/providers/` 里放自己的插件：

```js
// providers/*.js 或 ~/.whalepet/providers/*.js
module.exports = {
  meta: {
    id, label, vendor, badge, paths, desc,
    unit: 'token' | 'credit' | 'CNY',          // 这个来源的用量单位
    fields: [{ id, label, unit?, desc? }],     // 可勾到信息条上的字段
    damage: [[下限, 等级], ...],                // 受击阈值，可省
  },
  create(api) { return { poll(now, emit) {...}, raw(now) {...}, fields(now, ctx) {...} } },
}
```

宿主只注入一组小工具，插件**不直接 require 任何模块**，也不需要碰 Electron：

| 成员 | 说明 |
|---|---|
| `Tailer(file)` | 增量读追加内容的读取器 |
| `TailSet` | 管一批文件的增量读，并且直接告诉你这一行是**历史**还是**新到**（省掉每个插件手写 `armed` 开关） |
| `rollDay(now, state, onNewDay)` | 北京时间跨 00:00 时自动调 `onNewDay()` 清零当日累计 |
| `walkFiles` / `expand` | 递归找文件（可只取最近改过的）/ 展开 `~/xxx` |
| `bjDayKey` / `bjTodayStart` / `parseIso` / `num` | 时间与数值 |
| `UNIT_LABEL` / `withUnit(v, unit)` | 单位显示名 / 拼「值 + 单位」 |

**加一个插件只写它自己**：不用改 `usage.js`（阈值走 `meta.damage`、字段走 `meta.fields`、单位走 `meta.unit`），也不用改界面（`unit` 会自动渲染成数字后面的小字，`todayTokens` / `todayCredit` 会自动进「今日已用」合计）。

`providers/_template.js` 是能跑的骨架，`providers/README.md` 是完整说明（含可复制的最小示例）。**下划线开头的文件不会被加载** —— 想临时搁置一个插件，把它改名成 `_xxx.js` 就行。

单个插件语法错 / 抛异常只会让它自己显示「装载失败」，其余照常工作 —— 桌宠不会因为一个第三方插件变砖。加载错误会显示在设置窗口「数据源插件」底部的红条里。

装没装存在 `usage.json` 的 `installed` 里；卸载一个插件时它声明的字段会自动从信息条上摘掉，重新安装后回到「可添加的字段」（配置里的引用不会丢，插件放回来字段也跟着回来）。

### 一个现成的用户插件示例：手动记账

桌宠自带一个装在**用户目录**里的插件，它既是示例、也是真能用的兜底：

| | |
|---|---|
| 插件 | `~/.whalepet/providers/manual-ledger.js` |
| 账本 | `~/.whalepet/ledger.jsonl`（一行一条 JSON，`#` 开头的行当注释跳过） |

网页版 ChatGPT / Gemini、包月订阅这类**不在本机留日志**的服务，往里记一笔就能进信息条：

```powershell
Add-Content -Encoding UTF8 "$HOME\.whalepet\ledger.jsonl" '{"at":"2026-09-30T21:10:00+08:00","service":"ChatGPT 网页版","cost":1.25}'
```

字段「手动记账」默认**不显示**，在设置里点「＋ 手动记账」加进去。它在设置里标着「用户插件」，多一个「删除文件」按钮：删掉只删那一个 `.js`，`ledger.jsonl` 会留着。想改成自己的需求，直接编辑那个文件再点「重载插件」即可（不用重启）。

它同时也是**插件契约的一个活样板**：`meta.damage` 阈值、`meta.unit`、`Tailer` 增量读、`fields()` 里用 `ctx.fmtTokens` 做格式化、以及「首轮不发事件」都在这一个文件里能对照着看。

### 为什么读日志，而不是读数据库

WorkBuddy 的用量在 `~/.workbuddy/workbuddy.db` 里有 `session_usage(used, size, credit_json)` 表，但那是 SQLite；本桌宠跑在 Electron 33（Node 20.18），**没有内置 `node:sqlite`**，为一个只读的数字去引原生 sqlite 依赖不划算。所以改成跟踪纯文本日志——它同时给出**实时上下文**（`totalTokens=N` 每分钟都在刷新）和**逐笔计费**（`Credit received` 带 `requestId`，可按 id 去重）。实测扣费行基本是**写日志的同毫秒落盘**，所以受击动画能做到几乎实时。

`~/.workbuddy/projects/**/*.jsonl` 里其实有精确的 `providerData.rawUsage.credit`，但它只覆盖「本机作为客户端」的会话，而且上下文值没有运行时日志实时，所以没走那条路。

DSH 的原始会话是 `~/.dsh/sessions/**/session.v4.jsonl.zstd` —— **zstd 压缩，Node 20 内置模块没有解码器**（`node:zlib` 只到 gzip/br/deflate）。它的 `dsh-token-monitor` 账本是等价的明文副本，直接读那个。

日志读取踩过的坑都在 `providers/api.js` 和各插件的注释里，改之前先看：

- **尾部读取必须循环 `readSync` 直到没有剩余字节。** 单次 `readSync` 不保证读满（3MB 的会话日志一次只拿回一部分），而 `offset` 一旦推到 `stat.size`，没读到的部分就永久丢了。
- **日志会被自己污染。** 用工具打印日志内容时，WorkBuddy 会把这段输出又写回同一个日志；所以正则一律**行首锚定**（`^\[`），并对 `requestId` 去重。
- **一天里有多个会话日志。** 上下文只认最新的那一份（按每行时间戳比对），否则会读到旧会话的数值。首次见到某个日志文件时只累计历史、不发事件，避免启动瞬间炸一堆动画。
- **Claude Code 的日志里大量 `message.model === "<synthetic>"`**，usage 全是 0，必须跳过，否则「今日次数」会被空行灌水。
- **ZCode 的 model-io 文件很大**（单会话 1.5MB 起，`request.body` 里塞了完整 system prompt 和全部 tool schema），所以先做字符串预筛（`"usage"` + `"completedAt"`）再 `JSON.parse`。

### 环境变量

| 变量 | 作用 |
|---|---|
| `WHALEPET_USAGE=0` | 整个用量监控关闭（信息条不再出现） |
| `WHALEPET_USAGE_MS=1000` | 采集轮询间隔（默认 2500ms） |
| `WHALEPET_CTX_LIMIT=300000` | 上下文上限，用于算百分比（默认 30 万，与本地库里的会话窗口对齐） |
| `WHALEPET_NO_BALANCE=1` | 不请求 DeepSeek 余额接口（纯离线） |
| `WHALEPET_FAKE_HIT=3.5` | 验收用：启动后伪造一笔该金额的扣费，观察受击动画（配 `WHALEPET_CAPTURE=1` 会自动抓「受击帧 / 恢复帧」） |
| `WHALEPET_FAKE_HIT_AT=12000` | 配 `WHALEPET_FAKE_HIT` 用，改伪造扣费的触发时刻（毫秒） |
| `WHALEPET_FAKE_LEVEL=critical` | 配 `WHALEPET_FAKE_HIT` 用，直接指定受击等级，逐个验收动画 |
| `WHALEPET_OPEN_SETTINGS=1` | 启动就打开设置窗口（配 `WHALEPET_CAPTURE=1` 会抓一张窗口图）。旧的 `WHALEPET_OPEN_PANEL` 继续认 |
| `WHALEPET_PANEL_SELFTEST=1` | 验收用：在设置窗口里**真点一遍按钮**（大小 / 加字段 / 上移 / 移除 / 卸载 / 安装 / 重载），结果写进 `startup-report.json`，脚本见 `tools/settings-selftest.js` |
| `WHALEPET_RUN_ID=xxx` | 验收用：给这次启动打个标签，写进报告，便于区分是不是本次运行 |

### 隐私

余额需要 DeepSeek API key，本桌宠**只读**它、只用于本地发起一次 HTTPS 查询，不写入任何地方、不发给第三方：

- 优先取环境变量 `DEEPSEEK_API_KEY`；
- 否则从 `~/.dsh/.credentials.yaml` 里正则取出同一字段（只读该文件，不改写）。

不想联网就设 `WHALEPET_NO_BALANCE=1`。DSH 那半边的账是直接读插件自己的 `usage.jsonl`，不联网。

**所有插件都只读日志**，不写任何文件、不改原插件目录。

## 开机自启（可选）

1. `Win + R` 输入 `shell:startup` 回车，打开启动文件夹；
2. 右键 `启动鲸鱼娘桌宠.bat` →「显示更多选项」→「发送到」→「桌面快捷方式」，把快捷方式剪切到启动文件夹。

## 配置

`config.json`（自动生成）：位置 / 大小 / 置顶 / 形象

```json
{
  "x": 1280,        // 窗口位置（拖动后自动保存）
  "y": 460,
  "scale": 1,       // 0.7 小 / 1 中 / 1.4 大
  "alwaysOnTop": true,
  "skin": "ciallo"
}
```

`usage.json`（在设置里改，自动生成）：插件装没装 / 信息条字段与顺序

```json
{
  "installed": { "workbuddy": true, "dsh": true, "codex": true, "claude": true, "zcode": true },
  "fields": ["today", "ctx", "workbuddy", "dsh"]
}
```

`installed` 里没有的键默认视为「已安装」（`false` = 已卸载）；旧版本的键名是 `enabled`，含义一样，读到会自动转换，不用手动改。`fields` 里引用了不存在的字段 id（插件被卸载/删了）会**跳过而不删配置**，插件装回来字段也跟着回来。

## 目录结构

```
D:\WhalePet
├─ main.js               Electron 主进程（透明置顶窗、托盘、菜单、位置记忆、随光标移动、用量轮询）
├─ preload.js            安全桥接（contextIsolation 开启）
├─ usage.js              用量编排层：装载插件、汇总快照、把「信息条要显示什么」算成一个字段列表
├─ providers\            用量数据源插件（每个文件一个来源）
│  ├─ api.js             宿主注入给插件的工具（Tailer / TailSet / rollDay / walkFiles / 北京时间 / 数值）
│  ├─ index.js           插件加载器（内置 + 用户目录；下划线开头的不加载，单个插件出错不影响其他）
│  ├─ _template.js       新插件骨架（下划线开头，不会被当成插件加载）
│  ├─ workbuddy.js       WorkBuddy 运行时日志（单位：积分）
│  ├─ dsh.js             dsh-token-monitor 账本 + DeepSeek 余额（含峰谷表）
│  ├─ codex.js           OpenAI Codex CLI rollout
│  ├─ claude.js          Claude Code 会话
│  ├─ zcode.js           ZCode CLI model-io
│  └─ README.md          怎么写自己的用量插件（含可复制的最小示例）
├─ renderer\
│  ├─ index.html
│  ├─ pet.css            只写「位置」与「存在感」；外观来自 shared/pills.css
│  └─ pet.js             运行时帧扫描 + 帧播放状态机（待机/眨眼/acting/疼痛/开心）+ 信息条渲染
├─ shared\               两个窗口共用的信息条样式/渲染（外观的唯一真相）
│  ├─ pills.css          .pillbar 条容器 + .pill 胶囊 + 语义色
│  └─ pills.js           Pills.render / empty / key
├─ settings\             设置窗口（独立窗口）
│  ├─ index.html         外观 / 桌宠上显示 / 数据源插件 / 关于 四段
│  ├─ settings.css
│  ├─ settings.js        字段增删排序 + 插件安装卸载 + 实时预览 + 外观切换
│  └─ preload.js         只暴露这一组 IPC（window.settings.*）
├─ assets\
│  ├─ ciallo\            新形象（Ciallo～ 贴纸；只有一张原图，46 帧由程序变换合成）
│  └─ whale-girl\        原形象（58 个 PNG，来自 dsh-damage-pulse）
├─ tools\
│  ├─ make-launchers.py  生成两个 .bat（GBK+CRLF，并逐字节校验危险控制符）
│  ├─ make-ciallo-sticker.py  新形象去文字 + 去白边 + 抠图（见「素材说明」三步）
│  ├─ make-ciallo-frames.py   从干净贴纸程序化生成 46 帧 + 裁切自检
│  ├─ verify-panel.py    验收：启动桌宠 → 抓窗口图 → 开设置窗口 → 在窗口里真点一遍按钮
│  ├─ verify-hooks.js    上面那条链路里的抓图/注入钩子（只在验收模式下被 require）
│  ├─ settings-selftest.js 上面那一步注入到设置窗口里执行的点击脚本（两段：外观+加字段 / 撤销并断言）
│  ├─ verify-bat.py      按「双击」的方式跑启动脚本，截图确认桌宠真的显示出来
│  ├─ verify-usage.py    验收用量功能：伪造一笔扣费，抓「受击帧」与「恢复帧」
│  ├─ test-providers.js  命令行打印各插件读到的数据（带「时间旅行」验证解析）
│  ├─ test-user-plugin.js 验收用户级插件：读账本、跨天过滤、事件等级、卸载/安装/删除（跑完自动还原现场）
│  ├─ test-usage.js      命令行打印一次用量快照（排查数据源用）
│  ├─ test-balance.js    只测 DeepSeek 余额接口
│  ├─ diag-timeline.py   启动路径时间线（判断 Electron 是没起来还是起来后被回收）
│  ├─ diag-logs.js       打印 WorkBuddy 日志里被采集的那几行（核对日志格式）
│  ├─ diag-credit.js     核对 credit 行的去重结果
│  ├─ make-evidence.py   把验收截图拼成修复对照图（tools\fix-evidence.png）
│  └─ drag-verify.py     验收脚本：真实鼠标事件驱动拖动/单击 + 抓真实桌面截图
├─ 启动鲸鱼娘桌宠.bat
├─ 安装依赖.bat          依赖缺失时才需要（自动探测本机 npm）
├─ .gitignore            忽略 node_modules / 本机配置 / 验收截图
├─ LICENSE               MIT（形象素材的授权见文件末尾附注）
├─ config.json           运行后自动生成
└─ usage.json            第一次改设置后自动生成
```

应用目录之外还有两个位置（`~` 是用户主目录）。设置窗口右上角的「插件目录」按钮直接打开第一个：

```
~/.whalepet/
├─ providers\            你自己放的用量插件（放个 .js 进来、点「重载插件」就多一个来源）
│  └─ manual-ledger.js   示例插件「手动记账」，可删（也可以在设置里「卸载」）
└─ ledger.jsonl          上面那个插件的账本
```

> 两个 `.bat` 是**生成物**：改逻辑请改 `tools\make-launchers.py` 再重新生成，
> 不要直接编辑 .bat——文本编辑器存回 UTF-8/LF 就会重新踩上面那两个坑。

`tools\` 里带 `_` 前缀的文件是一次性的中间产物，可以随时删；`capture-*.png` /
`settings-window.png` / `settings-selftest-*.png` / `bar-*.png` / `_qa-*.png` /
`bat-launch-*.png` / `fix-evidence.png` 是验收脚本留下的证据图，重跑脚本会覆盖
（`.gitignore` 已把它们排除在仓库之外）。
其中 `bar-with-manual.png` 与 `bar-restored.png` 是**桌宠信息条的实拍**：前者是「在设置里勾上
『手动记账』之后」的信息条，后者是「再摘掉之后」的，用来证明设置里的选择真的落到了桌面上。

## 常见问题

- **背景不是透明的**：显卡驱动异常时 Electron 可能回退软渲染，透明仍然正常；若出现黑底，先按上面「沙箱与硬件加速」调 `WHALEPET_SANDBOX` / `WHALEPET_GPU`。
- **双击后窗口一闪就没、或报 `'xxd' 不是内部或外部命令`**：启动脚本被存成了 UTF-8 或 LF。用 `python tools\make-launchers.py` 重新生成。
- **双击了但桌宠不出现，任务管理器里却有几个 electron.exe**：多半是 `%~dp0` 尾斜杠把参数搞坏了（见上面第②条），重新生成启动脚本即可。
- **双击了没任何反应**：先看 `tools\startup-report.json`（需 `WHALEPET_REPORT=1` 启动）里有没有 `did-finish-load`。
- **从终端直接跑 `electron.exe .` 报 `Cannot read properties of undefined (reading 'commandLine')`**：环境里带了 `ELECTRON_RUN_AS_NODE=1`（WorkBuddy 的 bash、某些 CI 都会带），`electron.exe` 于是以**纯 Node** 身份运行，`app` 是 undefined，进程立刻退出且什么都不打印。跑之前 `unset ELECTRON_RUN_AS_NODE`（`tools\verify-panel.py` 里已显式摘掉）。双击 `.bat` 不受影响。
- **验收结果里出现「a 段跑了两遍」「同一张图抓了两次」这种看不懂的重复**：`tools/startup-report.json` 是**一个固定文件、整份覆盖写**。只要还有一个旧实例活着（手工 Ctrl-C 掉、或上一次崩了都会留下），两个进程就会轮流覆盖它，验收脚本于是读到「一半自己的、一半别人的」步骤。报告里现在带 `pid`，验收脚本用**自己拉起来的那个进程的 pid** 认领报告，不是它写的就当空；两处验收脚本也都会在启动前先 `taskkill` 一次。手工排查时如果结果反直觉，先确认 `tasklist | grep electron` 只有 4 个进程。
- **拖起来的时候鲸鱼娘看着像两个头**：那是 `idle-hands.png` 这张废弃素材的姿势问题，已修复（默认不再切这张图）。
- **想换大小 / 换形象**：右键 →「设置…」→ 外观，或直接改 `config.json` 的 `scale` / `skin`。改大小是**底边不动**地缩放，桌宠不会跳。
- **位置跑出屏幕外**：删除 `config.json` 后重启，会回到右下角默认位置。
- **想自己验一次拖动**：`python tools\drag-verify.py poll 16 24 9`，会在 `tools\ab\` 下留一组真实桌面截图；再跑 `python tools\make-evidence.py poll16` 拼成对照图。
- **想自己验一次启动脚本**：`python tools\verify-bat.py`，会按双击的方式启动并截图，确认「双击」这条路真的通（4 个进程 + 真实桌面截图）。跑完会把测试实例关掉、并把 `config.json` 还原成你原来的样子，所以不会把你的桌宠挪位置。
- **想自己验一次完整功能**：`python tools\verify-panel.py`，会启动桌宠、抓窗口图、伪造一次暴击扣费、开设置窗口，**并在窗口里真点一遍按钮**（切大小 / 加字段 → 上移 → 移除 → 卸载 → 安装 → 重载），最后把断言结果和截图一起打出来。跑完会自动还原 `usage.json` 与 `config.json`，不会改掉你在设置里做的选择。
- **想自己验一个用量插件**：`node tools\test-user-plugin.js`，会往账本里临时塞三条账目（含一条昨天的，验证跨天过滤）、检查事件等级、再试一次卸载/重新安装/删除，跑完把账本和 `usage.json` 都恢复原样。**这个脚本和 `test-providers.js` 必须串行跑**：前者会临时改写 `~/.whalepet/ledger.jsonl`，两个同时跑的话，后进来的那次会把「前一次塞进去的测试数据」当成原始账本备份、退出时再写回去，你的账本就被静默换掉了。脚本用 `~/.whalepet/.ledger-test.lock` 挡这件事（持有者已死会自动接管，所以上次被打断不会把你锁在外面）；`test-providers.js` 是只读的，不加锁，但看到锁会打印一行提醒。
- **信息条上的数字单位看不懂**：WorkBuddy 那一格是**积分**（它自己按 credit 计费），其余是 **token**。两个单位**不做换算**（1 积分 ≠ 多少 token，各家的计价口径并不通用），所以「今日已用」会并排写成 `5564.2万 token · 0.520 积分`。
- **卸载了一个插件，还想把它的字段放回信息条**：先「安装」把它装回来，字段就会回到「可添加的字段」里，再手动点 ＋ 加上去。**不会**自动塞回去 —— 否则排好的顺序会被悄悄改掉。
- **信息条不出现**：先确认没设 `WHALEPET_USAGE=0`；再 `node tools\test-providers.js` 看每个插件能不能读到数据（会打印「可用 / 无数据」和细节）。
- **某个来源一直显示 `--`**：在设置窗口里看那张卡片的状态行。Codex / ZCode / Claude 只有**最近几天**（3~7 天）有文件时才扫，`node tools\test-providers.js` 加 `WHALEPET_TEST_DAY=2026-09-29` 可以「时间旅行」到某天验证解析本身对不对。
- **自己写的插件不生效**：设置窗口底部会显示加载失败的原因（语法错、缺 `meta`、`create` 抛异常）。改完点「重载插件」，不用重启。也可以先 `node tools\test-providers.js` 看它有没有被装进来。
- **桌宠本体不见了，信息条还在但数字停在 `--`**：渲染端脚本一抛异常就整段停摆，页面上只剩样式表，桌面看不出任何提示。用 `WHALEPET_REPORT=1` 启动，`tools\startup-report.json` 里会有 `renderer:console` 记下具体报错和行号（`renderer/pet.js` 已把 `error` / `unhandledrejection` 桥到 `console.error`）。
- **余额一直是 `--`**：多半是拿不到 key 或没联网。`node tools\test-balance.js` 单测接口；不想联网就设 `WHALEPET_NO_BALANCE=1` 把余额那格变成 `--`，其余照常。
- **扣费了但鲸鱼娘没反应**：日志时间戳与系统时间差超过 1 小时的旧账会被丢弃（避免翻旧账）；确认对应的客户端正在跑并且写的是今天的日志。也可以用 `WHALEPET_FAKE_HIT=3.5 WHALEPET_FAKE_LEVEL=critical WHALEPET_CAPTURE=1` 单独验一遍「事件 → 动画」这条链路。
- **信息条的高度对不上（数字被裁掉 / 底下空一块）**：渲染端量完实际高度会回报给主进程（`usage:bar-height`），主进程保持**底边不动**地把窗口长上去。若手工改了 `pet.css` 的 padding，确认 `pet.js` 里 `reportBarHeight()` 的 `+12+6` 余量还匹配。
- **验收脚本抓到的设置窗口图是空的（`capturePage()` 返回 `0×0`）**：Windows 会把「被别的窗口完全盖住」的窗口判为 *occluded*，Chromium 随之**停止提交新帧**，于是抓图稳定为空 —— 而 `isVisible()` 是 `true`、`getBounds()` 也完全正常，光看窗口状态查不出来。桌宠因为 `alwaysOnTop` 从不被盖住，所以只有**设置窗口**会中招，而且时好时坏（取决于当时谁在最前面）。`main.js` 的 `captureWindowTo()` 有三道保险：抓之前把目标窗口**临时置顶**（抓完还原）、`webContents.invalidate()` 主动要一帧、再重试到拿到非空图；验收模式还会开 `disable-backgrounding-occluded-windows`。自己写抓图逻辑时别绕开它。失败时 `startup-report.json` 里的 `capture:empty` 会带上 `visible / minimized / offscreen / bounds`，先看那四个值能把「没显示」「最小化」「跑到屏幕外」「单纯被盖住」区分开。

## 与 DSH 插件的关系

本桌宠的素材**复制**自 DSH 插件 [dsh-damage-pulse](https://github.com/wssfk12138/dsh-damage-pulse)（其中的 `dsh-token-monitor`，负责记录 token 消耗）。插件本体、它的安装目录和 token 记录都**没有被改动**，两者互不影响：

- 插件安装位：`~/.dsh/profiles/{desktop,web}/node_modules/dsh-damage-pulse`
- token 记录：`~/.dsh/data/dsh-token-monitor/`（`usage.jsonl` / `request-details.jsonl` / `state.json`）
- 源码仓库：`~/.zcode/workspace/default/dsh-damage-pulse`

本桌宠只做**只读**消费：`providers/dsh.js` 读 `usage.jsonl` 里的当日 `cost`（按 `sessionId + sourceEventSeq` 去重），读 `~/.dsh/.credentials.yaml` 里的 key 调一次余额接口。不写回、不修改插件任何文件。

用量插件的分层思路（每个来源一个 adapter + 一个收集器 + 只读增量读日志）参考了 [iFence/TokenMonitor](https://github.com/iFence/TokenMonitor)；区别是本桌宠不需要额外运行时，直接复用 Electron 自己的 Node。

## 后续计划

- 补一张真正的「被拎起」姿势素材，替掉 `idle-hands.png`（现在拖动时保持待机姿态）。
- 充值时播放复苏序列（`revive-recharge-v1` 七帧已就位）。目前余额是轮询到的、没有「充值事件」，需要比较余额增量来触发。
- 信息条字段里加一条极简的「最近 24 小时花费」柱状走势。
- `providers/ciallo` 之外的第三方形象：现在换形象要手工准备整套帧目录，考虑支持「单张图自动生成」。
- 新形象（ciallo）目前是**单张静图变换**出来的，表情只有一种；后续可以按状态图生图补几套表情。
- 插件的「今日用量」目前由各插件自己的 `raw()` 报出来；考虑加一个**统一的日切事件**，让所有插件在跨天时一起归零（现在是各自 `rollDay`）。
- 设置窗口里的键盘可达性（Tab 顺序、焦点环）还没专门调过。
