// 鲸鱼娘桌宠主进程 v6
//
// 拖动有两条实现路线，用 WHALEPET_DRAG_MODE 切换，方便在真机上做 A/B 实测：
//   system : CSS -webkit-app-region: drag —— 窗口移动交给 DWM/系统（等价于拖动标题栏），
//            应用层零参与。移动本身不可能产生「旧帧没清掉」的错位。
//   poll   : 主进程按固定节拍读光标并 setPosition（绝对坐标，不做 delta 累加）。
//            渲染端只在按下/松开各发一次 IPC，移动期间零 IPC。
//
// 位置记忆：两种模式都在松开鼠标后读 getBounds 存盘。
//
// 右键菜单刻意只有三项（置顶 / 设置 / 退出）：大小、形象、信息条字段、插件管理、
// 动作时机全都在「设置」窗口里，菜单不该是个功能清单。
'use strict'

const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')
const usage = require('./usage')
const triggers = require('./shared/triggers')
const petsize = require('./shared/petsize')

const APP_VERSION = '1.2.0'
const CONFIG_PATH = path.join(__dirname, 'config.json')
const ASSETS_DIR = path.join(__dirname, 'assets')
const REPORT_PATH = path.join(__dirname, 'tools', 'startup-report.json')
// 窗口尺寸、以及「倍数最大能到多少」，算法都在 shared/petsize.js（纯几何，node 能直接测）。
// 信息条高度不写死：字段是可配置的，勾多了会换行变高，所以由渲染端量完回报
// （ipc 'usage:bar-height'），主进程再按 形象区 + 信息条 算总高。
const DEFAULT_BAR_H = 78
let BAR_H = DEFAULT_BAR_H

/* 默认尺寸：小（70%）。
 *
 * 桌宠是常年摆在桌面上的东西，不是需要看清每个像素的窗口 —— 按整只鱼原尺寸铺开
 * 会一直占掉屏幕一角。70% 放在桌角正好「在，但不碍事」，想要大的在设置里点一下
 * 就行（小 70% / 中 90% / 大 110%）。 */
const DEFAULT_SCALE = 0.7

function baseSize(scale) {
  return petsize.baseSize(scale, BAR_H)
}

/** 设置窗口传来的是数字，别信它：桌宠被设成 0.05 倍就没法用手拖回来了。 */
function clampScale(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return DEFAULT_SCALE
  return petsize.clampScale(n, BAR_H)
}

/* 形象（skin）：assets/ 下每个目录是一套形象，目录里的帧路径由 frameGroups() 约定。
 *   shayu —— 傻鱼：只有一张原画，整套动作帧由 tools/make-shayu-frames.py 合成 */
const SKINS = [
  { id: 'shayu', label: '傻鱼', desc: '单图合成整套动作' },
]
const DEFAULT_SKIN = 'shayu'

/* 动作（action）：形象里能播的动画。
 *
 * 这一张表管三处，所以「加一个动作」只要在 assets/<形象>/frames/ 里放好帧、再往这里
 * 加一行就行 —— frameGroups() 照它扫素材、设置窗口照它画可选清单、渲染端照它建 clip，
 * 不需要在三个文件里各写一遍名字。
 *
 *   slot    这个动作**默认**归在哪个时机（见 shared/triggers.js 的 TRIGGERS）。
 *           只用来生成初始名单 —— 生成完就归用户了，用户在设置里挪到别的时机上、
 *           或者同时放进几个时机，都跟这里写的无关。加新动作时写一行，它就会
 *           默认出现在对的时机里，不用再去别处登记。
 *   def:false 默认不放进任何时机（= 默认关着），用户想用自己在设置里加
 *   weight  在「待机随机」里的出现权重，默认 1
 *   frames  [帧名前缀, 张数]，文件形如 frames/<前缀>-01.png
 *   ms      每帧时长；给数组就逐帧用（长度不够时沿用最后一个）
 */
const ACTIONS = [
  { id: 'blink', label: '眨眼', slot: 'blink', ms: 56, frames: ['blink', 4],
    desc: '保持当前姿势不动，只把左眼眨一下（整段约 0.22 秒）' },
  { id: 'acting', label: '歪头放电', slot: 'idle', ms: 170, weight: 3, frames: ['acting', 8],
    desc: '待机时随机出现：歪一下头再回正' },
  { id: 'hips', label: '双手叉腰', slot: 'idle', ms: 170, weight: 3, frames: ['hips', 8],
    desc: '待机时随机出现：双手叉腰站着晃两下' },
  { id: 'revive', label: '打起精神', slot: 'idle', ms: 340, weight: 1, frames: ['revive', 7],
    desc: '待机时偶尔出现（比上面两个少见）：从没精神一路亮起来' },
  { id: 'happy', label: '开心（双击）', slot: 'click', ms: [155, 825, 80, 85], frames: ['happy', 4],
    desc: '左键双击时：蹲 → 蹦起来眨眼笑 → 落地' },
  { id: 'pain-weak', label: '轻痛', slot: 'hit', ms: [150, 470, 70, 100, 80, 80], frames: ['pain-weak', 6],
    desc: '小额扣费到账时的反应' },
  { id: 'pain-normal', label: '普通痛', slot: 'hit', ms: [150, 470, 70, 100, 80, 80], frames: ['pain-normal', 6],
    desc: '中等扣费：抖得更厉害，还会泛红' },
  { id: 'critical', label: '暴击', slot: 'hit', ms: 260, frames: ['critical', 6],
    desc: '大额扣费：抖得最狠，末帧再定住一张「连续受击」的样子' },
]

/* 时机（什么时候播）的默认名单由 shared/triggers.js 按上面这些 slot 生成。
 * 配置里存的是 `triggers: { 时机: [动作 id, ...] }`；**等于默认就不存**
 * （saveConfig 时写回 null），这样以后调默认值不会被一堆历史记录压住 —— 和
 * 之前 actions 开关的做法一致。 */
function currentTriggers() {
  return triggers.normalizeTriggers(cfg.triggers, actionsAvailable().list)
}

/* ---------- 沙箱 / 显卡兜底 ----------
 * Chromium 的渲染沙箱在部分机器上（远程桌面、安全软件、受限会话）会和宿主冲突：
 * 表现是 GPU 进程反复崩溃、Electron 紧接着 FATAL 退出，或窗口建出来却一片空白，
 * 用户体感就是「双击了但什么都没发生」——实测这台机器就是这种情况。
 * 本桌宠只加载本地素材、不访问任何网络页面，关掉沙箱的暴露面很小。
 * 想恢复默认：设 WHALEPET_SANDBOX=1 保留沙箱，设 WHALEPET_GPU=1 保留硬件加速。
 */
const USE_SANDBOX = process.env.WHALEPET_SANDBOX === '1'
const USE_GPU = process.env.WHALEPET_GPU === '1'

if (!USE_SANDBOX) app.commandLine.appendSwitch('no-sandbox')
if (!USE_GPU) app.disableHardwareAcceleration()

const DRAG_MODE = process.env.WHALEPET_DRAG_MODE === 'system' ? 'system' : 'poll'
const POLL_INTERVAL_MS = Number(process.env.WHALEPET_POLL_MS) > 0 ? Number(process.env.WHALEPET_POLL_MS) : 16
// 早期版本拖起来时会把姿态切成一张「双手前伸的俯视姿势」素材（idle-hands.png，已随旧形象一并删除），
// 在桌宠这个尺寸下看起来像两个头，实测截图确认这就是用户看到的「拖一下就变成怪物」。
// 现在默认关掉，拖动时保持正常待机姿态；新形象也没有专门的「被拎起」素材，故这个开关暂时是空转的。
const USE_DRAG_POSE = process.env.WHALEPET_DRAG_POSE === '1'

const DEFAULT_CONFIG = { x: null, y: null, scale: DEFAULT_SCALE, alwaysOnTop: true, skin: DEFAULT_SKIN, triggers: null }

// 形象目录不存在时回落到存在的那个，避免 config.json 里写了个错名字就一片空白
function resolveSkin(id) {
  const wanted = SKINS.some(s => s.id === id) ? id : DEFAULT_SKIN
  const dir = path.join(ASSETS_DIR, wanted)
  if (fs.existsSync(dir)) return { id: wanted, dir }
  const fallback = SKINS.find(s => s.id !== wanted && fs.existsSync(path.join(ASSETS_DIR, s.id)))
  if (!fallback) return { id: wanted, dir }
  return { id: fallback.id, dir: path.join(ASSETS_DIR, fallback.id) }
}

let SKIN = null
let ASSET_ROOT = ''

// 启动自检（WHALEPET_REPORT=1）：把真实启动路径写成报告文件。
// 排查这类问题的最大坑是「看不到应用内部走到哪一步」，这条链路要能自证。
//
// 报告里带上本次运行的 id 和自己的 pid：同一台机器上如果同时活着两个实例，报告是
// 同一个文件、后写的整份覆盖先写的，验收脚本就会读到「一半自己的、一半别人的」步骤
// （表现是「面板自检 a 段跑了两遍」「某张图抓了两次」这类看不懂的重复）。
// pid 是**同一个进程**的铁证 —— 拿它认领报告，比拿 runId 更紧。
const REPORTING = process.env.WHALEPET_REPORT === '1'
const RUN_ID = process.env.WHALEPET_RUN_ID || ''
const report = {
  startedAt: new Date().toISOString(),
  runId: RUN_ID,
  pid: process.pid,
  dragMode: DRAG_MODE,
  pollIntervalMs: POLL_INTERVAL_MS,
  steps: [],
}

function note(step, extra) {
  if (!REPORTING) return
  report.steps.push(extra === undefined ? step : { step, ...extra })
  try {
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true })
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8')
  } catch { /* 报告失败不影响运行 */ }
}

/**
 * 老配置的 `actions: { id: false }` 换到新的 `triggers` 名单上。
 *
 * 以前是「每个动作一个开关」，现在是「每个动作归到哪些时机里」，两套不能并存 ——
 * 留着两份状态，迟早出现「关掉了却还在播」这种说不清的状态。所以读的时候换算一次、
 * 把 actions 删掉，下次写盘就只剩新格式了。
 *
 * 换算很简单：先取全默认名单，再把「明确关掉过」的动作从每个时机里摘掉。
 * 注意这里用的是 ACTIONS 而不是扫出来的可用清单 —— 换形象、删素材都得等窗口起来
 * 之后才知道，而配置得在那之前就读好（cfg.skin 还等着用它决定加载哪套素材）。
 * 「确实存在的动作」由 currentTriggers() 每次读取时按可用清单再收一遍。
 *
 * **判据看的是文件里有没有 triggers 这个键，不是合并后的对象** —— DEFAULT_CONFIG
 * 里 `triggers: null`，拿 `cfg.triggers !== undefined` 去判会永远为真、直接跳过换算
 * （这个坑踩过：实测老配置读进来 actions 被无声删掉、改动全丢，config.json 变成
 * 一个干净的 `triggers: null`，看起来「像没事发生」）。
 */
function migrateConfig(raw) {
  // config.json 里写了个 `null` / 数字时，下面读 raw.triggers 会直接抛 ——
  // 而 loadConfig 的 try 只包住了读文件和 parse，接不住这里。症状是启动就炸、
  // 桌面上什么都看不到（双击没反应那一类）。当成空配置走全默认。
  if (!raw || typeof raw !== 'object') raw = {}

  const cfg = { ...DEFAULT_CONFIG, ...raw }

  // 尺寸也要夹一道：老配置里可能存着上一版的「大」= 1.4，而形象从 ~1.14 起就不
  // 再变大了（原因见 shared/petsize.js 的文件头）。留着它只会得到一个空框。
  const scale = clampScale(cfg.scale)
  if (scale !== cfg.scale) note('config:scale-clamped', { from: cfg.scale, to: scale })
  cfg.scale = scale

  if (raw.triggers !== undefined) {
    delete cfg.actions
    return cfg
  }
  const hadLegacy = raw.actions !== undefined
  // 换算规则本身在 shared/triggers.js 里（能测），这里只管「什么时候换算、换算完存不存」
  const t = triggers.fromLegacy(cfg.actions, ACTIONS)
  cfg.triggers = hadLegacy && !triggers.isDefault(t, ACTIONS) ? t : null
  delete cfg.actions
  if (hadLegacy) note('config:migrated', { triggers: cfg.triggers })
  return cfg
}

function loadConfig() {
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return { ...DEFAULT_CONFIG } // 文件不在或坏了：全默认（不写盘，等第一次真正要存时再建）
  }
  const cfg = migrateConfig(raw)
  // 换算过 / 夹过就**立刻落盘一次**。不落的话 config.json 里会一直躺着一个 `actions`
  // 字段（或者一个早就取不到的 scale），看着像还在生效（实际已经不读了），
  // 而且每次启动都得再换算一遍。
  if (raw.actions !== undefined || cfg.scale !== raw.scale) {
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8')
    } catch { /* 盘只读也照样能跑，只是老的 actions 会留到下次 */ }
  }
  return cfg
}

function saveConfig(patch) {
  const cfg = { ...loadConfig(), ...patch }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8')
  return cfg
}

let cfg = loadConfig()
let win = null
let tray = null
let dragTimer = null

SKIN = resolveSkin(cfg.skin)
ASSET_ROOT = SKIN.dir

/* 动作表 × 时机表的一致性检查。
 *
 * `slot` 写了个不存在的时机名，这个动作就默认不出现在任何时机里 —— 界面上其实看得见
 * （它会在「没安排时机」那条里），但没人会想到去看那儿。启动时核一遍、报告里留个痕，
 * 加动作时打错字就能立刻发现。 */
{
  const bad = ACTIONS.filter(a => !triggers.getTrigger(a.slot))
  if (bad.length > 0) {
    note('actions:bad-slot', { ids: bad.map(a => a.id), slots: bad.map(a => a.slot) })
    console.warn('[whalepet] 这些动作的 slot 不是有效的时机，默认不会出现在任何时机里：'
      + bad.map(a => a.id + ' -> ' + a.slot).join('、'))
  }
}

/* ---------- 动作清单 ---------- */

/**
 * 从素材清单里挑出**真有帧**的动作。
 *
 * 少于一帧就整条剔掉：设置里留一个点了没反应的开关，比不显示更让人困惑。
 * （帧生成器会成套写出，所以正常情况下一张不缺；这条是给手工改素材的人兜底。）
 */
function scanActions(all) {
  const out = []
  for (const a of ACTIONS) {
    const files = []
    for (let i = 1; i <= a.frames[1]; i += 1) {
      const rel = `frames/${a.frames[0]}-${String(i).padStart(2, '0')}.png`
      if (all.includes(rel)) files.push(rel)
    }
    if (files.length >= 2) out.push({ ...a, files })
  }
  return out
}

// 设置窗口会频繁调 appState()，而 listPngs 要遍历整个素材目录，所以缓存一份。
// 换形象会换 ASSET_ROOT，键一变就自动重扫。
let actionScan = { root: '', all: null, list: null }

function actionsAvailable() {
  if (actionScan.root !== ASSET_ROOT || !actionScan.all) {
    const all = listPngs(ASSET_ROOT)
    actionScan = { root: ASSET_ROOT, all, list: scanActions(all) }
  }
  return actionScan
}

/**
 * 设置窗口要的那一份「动作」：所有能用的动作 + 每个时机现在的名单。
 *
 * 拆成 catalog 和 triggers 两块，是因为界面上是**按时机分组**画的：
 * catalog 画「能加进这个时机的动作」那个下拉，triggers 画每一组里已经放了谁。
 *
 * catalog 的顺序 = ACTIONS 的声明顺序，不能改成按字母排 —— 「扣费反应」的轻重
 * 顺序也走这一份。
 */
function actionState() {
  const list = actionsAvailable().list
  const cur = triggers.normalizeTriggers(cfg.triggers, list)
  return {
    catalog: list.map(a => ({ id: a.id, label: a.label, desc: a.desc || '' })),
    triggers: triggers.TRIGGERS.map(t => ({
      id: t.id,
      label: t.label,
      desc: t.desc || '',
      ordered: !!t.ordered,
      ids: cur[t.id],
    })),
    used: triggers.usedCount(cur, list),
    total: list.length,
    unused: triggers.unused(cur, list),
  }
}

/**
 * 设置里改某个时机的名单。增、删、排序都走这一个口子：界面传整份新名单过来，
 * 主进程负责收拾干净（丢掉不存在的动作、去重）再存。
 *
 * 和默认一致就存回 null —— config.json 里只留「用户真的改过的那部分」，
 * 以后调默认值时不会被一堆历史记录压住。
 */
function setTrigger(slot, ids) {
  if (!triggers.getTrigger(slot)) return appState()
  const list = actionsAvailable().list
  const next = triggers.setList(currentTriggers(), slot, ids, list)
  cfg = saveConfig({ triggers: triggers.isDefault(next, list) ? null : next })
  // 名单变了要重建池子：让渲染端重新拉一次 frames（换形象是整页重载，这里轻一点就够）
  if (win && !win.isDestroyed()) win.webContents.send('actions-changed')
  return appState()
}

/** 设置里点「试演」：让桌面上的桌宠立刻播一次这个动作。 */
function previewAction(id) {
  if (!actionsAvailable().list.some(a => a.id === id)) return { ok: false, message: '没有这个动作' }
  if (!win || win.isDestroyed()) return { ok: false, message: '桌宠窗口不在了' }
  win.webContents.send('preview-action', id)
  return { ok: true }
}

function setSkin(id) {
  const next = resolveSkin(id)
  if (next.id === SKIN.id) return appState()
  SKIN = next
  ASSET_ROOT = next.dir
  cfg = saveConfig({ skin: next.id })
  note('skin:changed', { id: next.id, dir: next.dir })
  actionScan.root = '' // 素材目录变了，动作清单要重扫
  // 换形象要重扫素材、重建 clip，最省事也最不容易出错的做法就是让页面重载一次
  if (win && !win.isDestroyed()) win.webContents.reload()
  if (tray) buildTray()
  return appState()
}

/* 截图验证：WHALEPET_CAPTURE=1 时把**窗口自身**的像素存到 tools/。
 * 用 capturePage 而不是抓屏：抓屏得自己算窗口坐标，还会被 DPI 缩放（本机 150%）
 * 搅得对不上；capturePage 直接返回窗口内容，与坐标无关。 */
const CAPTURING = process.env.WHALEPET_CAPTURE === '1'

// 验收抓图专用开关。Windows 会把「被别的窗口完全盖住」的窗口判成 occluded，
// Chromium 随之**停止提交新帧**，capturePage() 于是稳定返回空图 —— 而 isVisible()
// 依然是 true、getBounds() 也完全正常，光看窗口状态根本查不出来（实测这台机器就是：
// 设置窗口 bounds=563,100 581x760、visible=true，重试 12 次仍全是 0×0）。
// 桌宠窗口因为 alwaysOnTop、从不被盖住，所以只有设置窗口中招。
// 这两个开关让 Chromium 即使被挡住也继续画。只在验收模式下打开，正常使用不受影响。
if (CAPTURING) {
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
}

/**
 * 抓一个窗口的画面。`which` 是 'pet'（桌宠）或 'settings'（设置窗口）。
 *
 * 三道保险，都是被实测逼出来的：
 *  1. 临时置顶。Windows 把「被完全盖住」的窗口判成 occluded，Chromium 就停画，
 *     capturePage 稳定返回 0×0 —— 而 isVisible()/getBounds() 全都正常，看不出异常。
 *     抓图期间顶到最上层，抓完还原。
 *  2. invalidate()。即使没被盖住，也可能只是这一帧还没提交；主动要一帧比干等有效。
 *  3. 重试到非空。**空图是 0×0**，跟「截到一帧空白内容」不一样，所以尺寸就能判。
 *
 * @param {string} which 'pet' | 'settings'
 * @param {string} name  tools/ 下的文件名
 * @param {object} opt   wait：首次尝试前等多久（等桌宠把新字段画上信息条要 3200）；
 *                       tries / gap：重试次数与间隔
 */
async function captureWindowTo(which, name, opt = {}) {
  if (!CAPTURING) return
  const tries = Math.max(1, opt.tries || 12)
  const gap = opt.gap || 400
  await new Promise(r => setTimeout(r, opt.wait || 0))

  const target = () => (which === 'settings' ? settingsWin : win)
  // 桌宠本来就是 alwaysOnTop，不用动它；只有普通窗口需要临时顶上去。
  let raised = null
  const t0 = target()
  if (t0 && !t0.isDestroyed() && !t0.isAlwaysOnTop()) {
    try { t0.setAlwaysOnTop(true); raised = t0 } catch { /* 忽略 */ }
  }

  try {
    for (let i = 0; i < tries; i += 1) {
      const w = target()
      if (!w || w.isDestroyed()) return
      // 刚建好的窗口偶尔还没真正上屏（isVisible 已经是 true，但 DWM 那边还没开始合成），
      // 这时 capturePage 会稳定地给 0×0。补一次 show() 是无害的幂等操作。
      if (!w.isVisible()) { try { w.show() } catch { /* 忽略 */ } }
      try { w.moveTop() } catch { /* 个别平台不支持，忽略 */ }
      try { w.webContents.invalidate() } catch { /* 忽略 */ }
      let image = null
      try {
        image = await w.webContents.capturePage()
      } catch { /* 下一轮再试 */ }
      const size = image && image.getSize()
      if (size && size.width > 0 && size.height > 0) {
        try {
          fs.writeFileSync(path.join(__dirname, 'tools', name), image.toPNG())
          note('capture:saved', { name, size })
        } catch { /* 存不下来不影响运行 */ }
        return
      }
      await new Promise(r => setTimeout(r, gap))
    }
    // 失败时把窗口自己的状态一起记下来。只写「抓不到」等于什么都没说 ——
    // 到底是窗口没显示、被最小化、还是整块跑到屏幕外面去了，这三者要修的地方完全不同。
    const w = target()
    let why = '窗口已销毁'
    if (w && !w.isDestroyed()) {
      const b = w.getBounds()
      why = 'visible=' + w.isVisible() + ' minimized=' + w.isMinimized()
        + ' offscreen=' + w.webContents.isOffscreen()
        + ' bounds=' + b.x + ',' + b.y + ' ' + b.width + 'x' + b.height
    }
    note('capture:empty', { name, which, message: '重试 ' + tries + ' 次仍是空图', why })
  } finally {
    if (raised && !raised.isDestroyed()) {
      try { raised.setAlwaysOnTop(false) } catch { /* 忽略 */ }
    }
  }
}

function captureTo(tag, delayMs) {
  captureWindowTo('pet', 'capture-' + tag + '.png', { wait: delayMs })
}

function listPngs(dir, prefix = '') {
  const out = []
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...listPngs(path.join(dir, entry.name), rel))
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.png')) out.push(rel)
  }
  return out
}

function pickExisting(relPaths) {
  return relPaths.filter(rel => fs.existsSync(path.join(ASSET_ROOT, rel)))
}

/**
 * 交给渲染端的素材清单。
 *
 * 帧路径**不写死在这里**：动作叫什么、什么时候播、每帧停多久，全在 ACTIONS 那张表里，
 * 这里只负责「按那张表去素材目录把帧找出来」。所以加一个动作 = 放好帧 + 加一行表项。
 */
function frameGroups() {
  const { all, list } = actionsAvailable()
  const has = rel => all.includes(rel)
  const idle = Array.from({ length: 8 }, (_, i) => `frames/idle-${String(i + 1).padStart(2, '0')}.png`).filter(has)

  return {
    assetRoot: ASSET_ROOT,
    skin: SKIN.id,
    dragMode: DRAG_MODE,
    dragPose: USE_DRAG_POSE,
    idle: idle.length > 0 ? idle : pickExisting(['idle.png']),
    // 动作 -> 帧。渲染端拿到**全部**动作（含一个时机都没进的），因为「试演」要能
    // 播没在用的动作；至于什么时候播，看下面的 triggers。
    actions: list.map(a => ({
      id: a.id,
      label: a.label,
      ms: a.ms,
      weight: a.weight || 1,
      frames: a.files,
    })),
    // 时机 -> 有序的动作 id 名单。渲染端照它建各时机的池子，自己不认识任何时机名，
    // 更不认识任何动作名 —— 所以「双击改播别的」不用动它一行代码。
    triggers: triggers.normalizeTriggers(cfg.triggers, list),
    states: {
      // 只在「最重的那档扣费反应」末尾定格用一张，见 renderer/pet.js 的 buildClips
      painCombo: pickExisting(['states/critical-combo.png']),
      // 拖动姿势：这一版形象没有「被拎起来」的专门素材，留个口子，扫不到就没有 drag 片段
      draggedIdle: pickExisting(['states/drag.png']),
    },
  }
}

/** 设置窗口要的「外观」这一块。集中在这里，免得各处自己拼。 */
function appState() {
  return {
    version: APP_VERSION,
    scale: Number(cfg.scale) || DEFAULT_SCALE,
    skin: SKIN.id,
    alwaysOnTop: cfg.alwaysOnTop !== false,
    skins: SKINS.map(s => ({ id: s.id, label: s.label, desc: s.desc || '' })),
    actions: actionState(),
  }
}

function setScale(scale) {
  cfg = saveConfig({ scale })
  if (win && !win.isDestroyed()) {
    const b = win.getBounds()
    const { w, h } = baseSize(scale)
    // 保持底边不动地把窗口缩放到新尺寸：直接改 width/height 是往右下长，
    // 桌宠看起来会「跳」一下。
    win.setBounds({ x: b.x, y: b.y + (b.height - h), width: w, height: h })
    win.webContents.send('scale-changed', scale)
  }
  return appState()
}

function normalizeWindowSize() {
  // Windows 在 150% 这类非整倍缩放上做移动时，会按物理像素重新换算窗口尺寸，
  // 每次都多出几个像素；不归一化的话窗口会越拖越大（虽然看不见，但会挡住底下的点击）。
  if (!win || win.isDestroyed()) return
  const scale = Number(cfg.scale) || DEFAULT_SCALE
  const { w, h } = baseSize(scale)
  const b = win.getBounds()
  if (b.width !== w || b.height !== h) {
    note('normalizeSize', { from: [b.width, b.height], to: [w, h] })
    win.setBounds({ x: b.x, y: b.y, width: w, height: h })
  }
}

/**
 * 信息条换行变高时调这个。
 * 关键点：**保持窗口底边不动**（信息条贴底），只把顶边往上推 ——
 * 直接 setBounds 改 height 会让窗口向下长，桌宠本体跟着掉下去，视觉上很晃。
 */
function setBarHeight(h) {
  const px = Math.max(40, Math.min(320, Math.round(Number(h) || DEFAULT_BAR_H)))
  if (Math.abs(px - BAR_H) < 2) return
  BAR_H = px
  note('usage:bar-height', { h: px })
  if (!win || win.isDestroyed()) return
  const scale = Number(cfg.scale) || DEFAULT_SCALE
  const { w, h: target } = baseSize(scale)
  const b = win.getBounds()
  win.setBounds({ x: b.x, y: b.y + (b.height - target), width: w, height: target })
  win.webContents.send('bar-height', BAR_H)
}

function setAlwaysOnTop(on) {
  cfg = saveConfig({ alwaysOnTop: on })
  if (win && !win.isDestroyed()) {
    win.setAlwaysOnTop(on, 'screen-saver')
    win.webContents.send('ontop-changed', on)
  }
  return appState()
}

function buildTray() {
  // 托盘图标直接用形象根目录那张成品图（由 tools/make-shayu-frames.py 生成）；
  // 万一丢了就用空图标 —— 宁可没图标，也不要因为图标丢了整个托盘起不来
  const icon = path.join(ASSET_ROOT, 'idle.png')
  const trayImg = fs.existsSync(icon)
    ? nativeImage.createFromPath(icon).resize({ width: 32, height: 32 })
    : nativeImage.createEmpty()
  if (tray) { tray.destroy(); tray = null }
  tray = new Tray(trayImg)
  tray.setToolTip(`鲸鱼娘桌宠 · ${SKIN.id}`)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示', click: () => win && win.show() },
    { label: '设置…', click: () => openSettingsWindow() },
    { label: '退出', click: () => app.quit() },
  ]))
  tray.on('click', () => win && win.show())
}

/* ---------- 设置窗口（独立窗口） ---------- */

let settingsWin = null

function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    note('settings:reuse')
    settingsWin.show()
    settingsWin.focus()
    return
  }
  note('settings:create')
  settingsWin = new BrowserWindow({
    // 比原来（580）宽出 120：左侧多了一条 154px 的导航栏，内容区得留住原来的宽度，
    // 否则插件卡片上「角标 + 名字 + 厂商 + 内置/用户插件 + 两个按钮」会挤着换行。
    width: 700,
    // 高度从 760 收到 660：分页之后单页内容短了很多，760 高会让「外观」那种三行页
    // 底下空一大片。插件那页本来就该滚动，不靠窗口高度硬撑。
    height: 660,
    minWidth: 560,
    minHeight: 420,
    title: '设置 · 鲸鱼娘桌宠',
    // 和窗口自己的浅色底一致，避免打开瞬间闪一下深色
    backgroundColor: '#eef4fc',
    autoHideMenuBar: true,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'settings', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  settingsWin.loadFile(path.join(__dirname, 'settings', 'index.html'))
  settingsWin.on('closed', () => { settingsWin = null })

  // 验收钩子（抓图 / 注入点击自检）单独放一个文件 —— 它跟窗口功能无关，
  // 摆在主流程里只会把 openSettingsWindow 埋掉。
  require('./tools/verify-hooks.js').attachPanelVerify(settingsWin, { note, capture: captureWindowTo })
}

/** 两个窗口共用同一份主进程数据；有新快照就一起推。 */
function broadcastUsage(snapshot) {
  if (win && !win.isDestroyed()) win.webContents.send('usage', snapshot)
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('usage', snapshot)
}

/**
 * 立刻补采一轮并推快照（不转发事件）。
 *
 * 插件刚被装载/卸载/重载时实例是新的，可用状态和明细都还是空的；不补这一轮，
 * 面板上会短暂显示「全部无数据」，看着像插件一下子全坏了。
 * 刻意**不转发事件**：装插件是用户动作，不该顺带炸一串受击动画。
 *
 * **必须异步**：采集本身是同步的，而插件刚被重载时实例是全新的 —— 首轮要把增量读取器
 * 从零建立起来（把当天的日志/会话文件读一遍，实测 600ms 上下）。同步跑的话，这次
 * 「卸载插件」的 IPC 回包也要等它，面板上就表现成「点了，半秒多才有反应」。
 * 快照本来就是推给渲染端的，晚一拍没有任何影响。
 */
function refreshUsage() {
  setImmediate(() => {
    try {
      broadcastUsage(usage.poll().snapshot)
    } catch (err) {
      note('usage:poll-failed', { message: String((err && err.message) || err) })
    }
  })
}

/** 右键菜单：只留三项。功能都搬进设置窗口了，菜单不是功能清单。 */
function buildMenu() {
  return Menu.buildFromTemplate([
    { label: '置顶', type: 'checkbox', checked: cfg.alwaysOnTop !== false, click: item => setAlwaysOnTop(item.checked) },
    { type: 'separator' },
    { label: '设置…', click: () => openSettingsWindow() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ])
}

/* ---------- poll 模式：主进程按固定节拍跟随光标 ---------- */

function startPollDrag() {
  if (DRAG_MODE !== 'poll' || !win || dragTimer) return
  const cursor = screen.getCursorScreenPoint()
  const origin = win.getBounds()
  const offset = { x: cursor.x - origin.x, y: cursor.y - origin.y }
  note('pollDrag:start', { cursor, origin, offset })
  dragTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return
    const now = screen.getCursorScreenPoint()
    win.setPosition(Math.round(now.x - offset.x), Math.round(now.y - offset.y), false)
  }, POLL_INTERVAL_MS)
}

// 注意：不要在这个高频繁循环里顺手 setBounds 纠正尺寸。
// 实测它和 Windows 的 DPI 缩放会互相打架（设 380 读回 384/388，永不收敛），
// 结果是每 8 拍一次 setBounds 抖动，比它想修的那几像素漂移更难看。松手时校正一次即可。

function stopPollDrag() {
  if (!dragTimer) return
  clearInterval(dragTimer)
  dragTimer = null
  note('pollDrag:stop', { bounds: win && !win.isDestroyed() ? win.getBounds() : null })
}

function createWindow() {
  note('createWindow:enter')
  const display = screen.getPrimaryDisplay()
  const { width: sw, height: sh } = display.workAreaSize
  const scale = Number(cfg.scale) || DEFAULT_SCALE
  const { w, h } = baseSize(scale)
  const x = Number.isInteger(cfg.x) ? cfg.x : Math.max(0, sw - w - 40)
  const rawY = Number.isInteger(cfg.y) ? cfg.y : Math.max(0, sh - h - 8)
  // 信息条让窗口变高了；夹一下，避免旧配置的位置把底部顶到屏幕外面
  const y = Math.min(Math.max(0, rawY), Math.max(0, sh - h))
  note('createWindow:geometry', { x, y, w, h, scale, scaleFactor: display.scaleFactor })

  win = new BrowserWindow({
    x, y, width: w, height: h,
    transparent: true,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    thickFrame: false,
    alwaysOnTop: cfg.alwaysOnTop !== false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.setAlwaysOnTop(cfg.alwaysOnTop !== false, 'screen-saver')

  const handle = win.getNativeWindowHandle()
  note('createWindow:created', {
    bounds: win.getBounds(),
    visible: win.isVisible(),
    hwnd: handle.readUInt32LE(0),
  })

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    note('webContents:did-fail-load', { code, desc, url })
  })
  // 渲染端脚本抛错时，桌面上的表现只是「图没出来、数字停在 --」，看不出原因。
  // 把渲染端 console 的 warn/error 收进启动报告，这类问题就能自证。
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level < 2) return
    note('renderer:console', {
      level: level === 3 ? 'error' : 'warn',
      message: String(message).slice(0, 400),
      at: path.basename(String(sourceId || '')) + ':' + line,
    })
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    note('webContents:render-process-gone', { reason: details && details.reason })
  })
  win.webContents.on('did-finish-load', () => {
    note('webContents:did-finish-load', {
      url: win.webContents.getURL(),
      bounds: win.getBounds(),
      sandbox: USE_SANDBOX,
    })
    win.webContents.send('drag-mode', DRAG_MODE)
  })

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))

  // 截图验证钩子：WHALEPET_CAPTURE=1 时，按 WHALEPET_CAPTURE_MS（逗号分隔的毫秒）逐点抓帧
  if (CAPTURING) {
    const delays = String(process.env.WHALEPET_CAPTURE_MS || '3500')
      .split(',')
      .map(s => Number(s.trim()))
      .filter(n => Number.isFinite(n) && n >= 0)
    win.webContents.once('did-finish-load', () => {
      for (const ms of delays) captureTo('t' + ms + 'ms', ms)
    })
  }

  win.on('closed', () => { win = null; app.quit() })
}

const gotLock = app.requestSingleInstanceLock()
note('boot', {
  gotLock,
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  argv: process.argv.slice(0, 4),
  runAsNode: process.env.ELECTRON_RUN_AS_NODE || null,
})
if (!gotLock) {
  note('boot:singleton-lock-denied')
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus() }
  })

  setTimeout(() => {
    note('boot:fallback-snapshot', {
      hasWindow: Boolean(win),
      destroyed: win ? win.isDestroyed() : null,
      visible: win ? win.isVisible() : null,
      bounds: win ? win.getBounds() : null,
      gpu: app.getGPUFeatureStatus(),
    })
  }, 6000)

  app.whenReady().then(() => {
    note('boot:whenReady')
    createWindow()
    buildTray()

    // 渲染端每次加载只问一次，所以这里强制重扫 —— 重新生成过动作帧之后刷新就能看到
    ipcMain.handle('frames', () => { actionScan.root = ''; return frameGroups() })
    ipcMain.handle('get-config', () => loadConfig())
    ipcMain.on('save-pos', () => {
      if (!win) return
      normalizeWindowSize()
      const b = win.getBounds()
      saveConfig({ x: b.x, y: b.y })
    })
    ipcMain.on('drag-start', () => startPollDrag())
    ipcMain.on('drag-end', () => {
      stopPollDrag()
      if (!win) return
      normalizeWindowSize()
      const b = win.getBounds()
      saveConfig({ x: b.x, y: b.y })
    })
    ipcMain.on('open-menu', (_e, px, py) => {
      buildMenu().popup({ window: win, x: Math.round(px), y: Math.round(py) })
    })

    // 渲染端量出信息条实际高度后回报 —— 字段勾多了会换行，窗口得跟着长
    ipcMain.on('usage:bar-height', (_e, h) => setBarHeight(h))

    /* ---------- 设置窗口 IPC ----------
     * 约定：所有会改配置的调用统一返回 { app?, usage?, providers? }，只回被改动的那几块。
     * 渲染端因此只写一遍合并逻辑（settings.js 的 absorb），不用知道「哪个操作动哪一块」。
     */
    const bundle = extra => ({
      usage: usage.publicConfig(),
      providers: usage.listProviders(),
      ...extra,
    })
    ipcMain.handle('settings:load', () => bundle({ app: appState() }))
    ipcMain.handle('settings:scale', (_e, v) => bundle({ app: setScale(clampScale(v)) }))
    ipcMain.handle('settings:skin', (_e, id) => bundle({ app: setSkin(String(id)) }))
    // 时机名单：传整个数组（增 / 删 / 排序都是它），主进程负责收拾
    ipcMain.handle('settings:trigger', (_e, slot, ids) => bundle({ app: setTrigger(String(slot), Array.isArray(ids) ? ids.map(String) : []) }))
    // 试演不改配置，只让桌面上的桌宠立刻播一次
    ipcMain.handle('settings:preview', (_e, id) => previewAction(String(id)))
    ipcMain.handle('settings:ontop', (_e, on) => bundle({ app: setAlwaysOnTop(!!on) }))
    ipcMain.handle('settings:fields', (_e, ids) => {
      usage.setFields(Array.isArray(ids) ? ids : [])
      return bundle()
    })
    ipcMain.handle('settings:install', (_e, id, on) => {
      usage.installProvider(String(id), !!on)
      refreshUsage()
      return bundle()
    })
    ipcMain.handle('settings:delete', (_e, id) => {
      const res = usage.deleteProvider(String(id))
      if (!res.ok) return { ok: false, message: res.message, ...bundle() }
      refreshUsage()
      return { ok: true, ...bundle() }
    })
    ipcMain.handle('settings:reload', () => {
      usage.reload()
      refreshUsage() // 插件实例是重建的，不补采就会短暂显示「全部无数据」
      return bundle()
    })
    ipcMain.handle('settings:open-dir', () => {
      const dir = require('./providers').USER_DIR
      try {
        fs.mkdirSync(dir, { recursive: true })
        require('electron').shell.openPath(dir)
      } catch (err) {
        return { dir, error: String((err && err.message) || err) }
      }
      return { dir }
    })
    ipcMain.on('settings:close', () => {
      if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close()
    })

    /* ---------- 用量采集 ---------- */
    // 只在主进程做采集，渲染端纯展示：渲染端碰文件系统既没必要也不安全。
    // usage.poll() 是同步的，首轮要把当天日志读全文（几十到几百毫秒），
    // 所以推迟 2 秒再开工，别跟首帧抢时间。
    let usageTimer = null
    if (usage.DISABLED) {
      note('usage:disabled')
    } else {
      const pushUsage = () => {
        let result
        try {
          result = usage.poll()
        } catch (err) {
          note('usage:poll-failed', { message: String((err && err.message) || err) })
          return
        }
        broadcastUsage(result.snapshot)
        // 每笔扣费单独发一条，渲染端按事件里的 level 挑受击强度
        if (win && !win.isDestroyed()) {
          for (const ev of result.events) win.webContents.send('usage-event', ev)
        }
      }
      setTimeout(() => {
        pushUsage()
        usageTimer = setInterval(pushUsage, usage.POLL_MS)
        note('usage:loop-started', { pollMs: usage.POLL_MS, ctxLimit: usage.CTX_LIMIT })
      }, 2000)

      // 验收钩子：WHALEPET_OPEN_SETTINGS=1 时启动就打开设置窗口并抓一张图，
      // 不然要手动右键点菜单才能看到它长什么样。
      // （旧变量名 WHALEPET_OPEN_PANEL 继续认，免得旧脚本忽然失效。）
      if (process.env.WHALEPET_OPEN_SETTINGS === '1' || process.env.WHALEPET_OPEN_PANEL === '1') {
        setTimeout(() => { note('settings:auto-open'); openSettingsWindow() }, 3500)
      }

      // 验收用：WHALEPET_FAKE_HIT=2.5 会在启动 12 秒后伪造一笔扣费，
      // 用来确认「事件 -> 渲染端 -> 受击动画 + 飘数字」这条链路通不通（真实扣费等不来）。
      // WHALEPET_FAKE_LEVEL 可以指定等级（默认按这笔金额和插件的阈值推），用来逐个验收动画。
      // WHALEPET_FAKE_BURST=8 则一次伪造 8 笔（金额 0.1、0.2、0.3…），
      // 模拟「一次日志落盘带回来十几条记录」——用来确认数字是**逐笔**飘的，
      // 而不是被加成一个合计；一张截图里就能看出这一点。
      // 文案和等级都走 usage.eventOf()，**和真实扣费同一条口径** —— 不然验收验的是另一套代码。
      const fakeHit = Number(process.env.WHALEPET_FAKE_HIT)
      if (Number.isFinite(fakeHit) && fakeHit > 0) {
        setTimeout(() => {
          if (win && !win.isDestroyed()) {
            const burst = Math.max(1, Math.floor(Number(process.env.WHALEPET_FAKE_BURST) || 1))
            for (let i = 0; i < burst; i++) {
              const amount = burst > 1 ? Number((0.1 * (i + 1)).toFixed(2)) : fakeHit
              const auto = usage.eventOf('workbuddy', amount, 'credit')
              const level = process.env.WHALEPET_FAKE_LEVEL || auto.level
              note('usage:fake-hit', { amount, hitValue: auto.hitValue, level })
              win.webContents.send('usage-event', {
                source: 'workbuddy', amount, unit: 'credit', at: Date.now(), id: 'fake-hit',
                hitValue: auto.hitValue, hitUnit: auto.hitUnit, level,
              })
            }
            // 抓帧按「事件」对齐，而不是按「启动后 N 秒」——冷启动耗时浮动，
            // 固定延时很容易抓空（实测两次相差 1.3 秒就完全错开了动画）。
            if (process.env.WHALEPET_PROBE === '1') {
              setTimeout(() => {
                win.webContents.executeJavaScript(`(() => {
                  const l = document.getElementById('hit');
                  if (!l) return { layer: 'missing' };
                  const lr = l.getBoundingClientRect();
                  const items = Array.from(l.querySelectorAll('.hit-num'));
                  const first = items[0];
                  const cs = first ? getComputedStyle(first) : null;
                  const ir = first ? first.getBoundingClientRect() : null;
                  const top = ir ? document.elementFromPoint(ir.x + ir.width / 2, ir.y + ir.height / 2) : null;
                  // pointer-events:none 会让 elementFromPoint 直接穿透，所以先临时打开再测，
                  // 否则永远只能看到底下那个元素，测不出真实的绘制层次。
                  let over = null;
                  if (ir) {
                    const save = l.style.pointerEvents;
                    l.style.pointerEvents = 'auto';
                    const t2 = document.elementFromPoint(ir.x + ir.width / 2, ir.y + ir.height / 2);
                    over = t2 ? (t2.id || t2.tagName + '.' + t2.className) : null;
                    l.style.pointerEvents = save;
                  }
                  return {
                    layer: [lr.x, lr.y, lr.width, lr.height],
                    view: [document.documentElement.clientWidth, document.documentElement.clientHeight],
                    count: items.length,
                    box: ir ? [ir.x, ir.y, ir.width, ir.height] : null,
                    onTop: top ? (top.id || top.tagName + '.' + top.className) : null,
                    hiddenUnder: over,
                    zLayer: getComputedStyle(l).zIndex,
                    zPet: getComputedStyle(document.getElementById('pet')).zIndex,
                    hasContent: l.offsetParent !== null || l.offsetHeight > 0,
                    style: cs ? { opacity: cs.opacity, color: cs.color, fontSize: cs.fontSize, animation: cs.animationName, display: cs.display, visibility: cs.visibility } : null,
                  };
                })()`).then(v => note('probe:hit', v)).catch(e => note('probe:hit-failed', String(e)))
              }, 600)
            }
            // PROBE=2：把飘字动画掐掉、透明度钉成 1，再抓一张静态帧。
            // 用来把「根本没画上去」和「画上去了只是动画正淡出/被画面淹掉」分开 ——
            // 光看按时间抓的那张图区分不出来，很容易在错误的方向上改半天。
            if (process.env.WHALEPET_PROBE === '2') {
              setTimeout(() => {
                win.webContents.executeJavaScript(
                  `Array.from(document.querySelectorAll('#hit .hit-num')).forEach(e => { e.style.animation = 'none'; e.style.opacity = '1'; });
                   document.querySelectorAll('#hit .hit-num').length`
                ).then(n => {
                  note('probe:kill-anim', { n })
                  return captureWindowTo('pet', 'probe-hit-static.png', { wait: 200 })
                }).catch(e => note('probe:kill-anim-failed', String(e)))
              }, 700)
            }
            if (CAPTURING) {
              // 排队节奏 170ms/笔 + 动画进到第 2~3 帧。原来取 500ms 正好落在
              // critical 的第一帧上（每帧 260ms），那帧如果不是「已经在反应」
              // 就会被误判成「动画根本没播」——这个坑踩过一次，别再改回去。
              captureTo('hit', 950)
              captureTo('after', 4500) // 应已回到待机
            }
          }
        }, Number(process.env.WHALEPET_FAKE_HIT_AT) > 0 ? Number(process.env.WHALEPET_FAKE_HIT_AT) : 12000)
      }
    }
    app.on('before-quit', () => {
      if (usageTimer) {
        clearInterval(usageTimer)
        usageTimer = null
      }
    })
  })

  app.on('child-process-gone', (_e, details) => {
    note('child-process-gone', { type: details.type, reason: details.reason, exitCode: details.exitCode })
  })

  app.on('window-all-closed', () => app.quit())
}
