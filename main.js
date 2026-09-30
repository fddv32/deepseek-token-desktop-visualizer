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
// 右键菜单刻意只有三项（置顶 / 设置 / 退出）：大小、形象、信息条字段、插件管理
// 全都在「设置」窗口里，菜单不该是个功能清单。
'use strict'

const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')
const usage = require('./usage')

const APP_VERSION = '1.2.0'
const CONFIG_PATH = path.join(__dirname, 'config.json')
const ASSETS_DIR = path.join(__dirname, 'assets')
const REPORT_PATH = path.join(__dirname, 'tools', 'startup-report.json')
const BASE_W = 380
// 420 是鲸鱼娘本体，底部再留一条用量信息条。
// 信息条高度不写死：字段是可配置的，勾多了会换行变高，所以由渲染端量完回报
// （ipc 'usage:bar-height'），主进程再按 PET_AREA_H + BAR_H 算总高。
const PET_AREA_H = 420
const DEFAULT_BAR_H = 78
let BAR_H = DEFAULT_BAR_H

function baseSize(scale) {
  return {
    w: Math.round(BASE_W * scale),
    h: Math.round((PET_AREA_H + BAR_H) * scale),
  }
}

/** 设置窗口传来的是数字，别信它：桌宠被设成 0.05 倍就没法用手拖回来了。 */
function clampScale(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 1
  return Math.min(2, Math.max(0.5, Math.round(n * 100) / 100))
}

/* 形象（skin）：assets/ 下每个目录是一套形象，目录结构必须一致
 * （frameGroups() 用的相对路径两套都通用）。
 *   ciallo     —— 新形象：Ciallo～ 贴纸，只有一张原图，帧是程序化合成的
 *   whale-girl —— 原形象：来自 dsh-damage-pulse 的分帧素材，保留可切回 */
const SKINS = [
  { id: 'ciallo', label: 'Ciallo～ 贴纸', desc: '单图合成 46 帧' },
  { id: 'whale-girl', label: '经典鲸鱼娘', desc: '原 dsh-damage-pulse 素材' },
]
const DEFAULT_SKIN = 'ciallo'

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
// 拖动姿势素材 idle-hands.png 是「双手前伸的俯视姿势」，在桌宠这个尺寸下看起来像两个头，
// 实测截图确认这就是用户看到的「拖一下就变成怪物」。默认关掉，拖动时保持正常待机姿态。
const USE_DRAG_POSE = process.env.WHALEPET_DRAG_POSE === '1'

const DEFAULT_CONFIG = { x: null, y: null, scale: 1, alwaysOnTop: true, skin: DEFAULT_SKIN }

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

function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
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

function setSkin(id) {
  const next = resolveSkin(id)
  if (next.id === SKIN.id) return appState()
  SKIN = next
  ASSET_ROOT = next.dir
  cfg = saveConfig({ skin: next.id })
  note('skin:changed', { id: next.id, dir: next.dir })
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

function frameGroups() {
  const all = listPngs(ASSET_ROOT)
  const has = rel => all.includes(rel)
  const seq = (dir, names) => names.map(n => `${dir}/${n}.png`).filter(has)
  const r4 = n => `feedback-expression-v4-r4-model/frames/${n}.png`

  const idle = seq('idle-v4-r2', Array.from({ length: 8 }, (_, i) => `idle-${String(i + 1).padStart(2, '0')}`))
  const blink = pickExisting([
    'idle-v4-r2/blink-soft.png',
    'idle-v4-r2/blink-half-close.png',
    'idle-v4-r2/blink-reopen.png',
  ])
  const acting = seq('idle-v4-r2', Array.from({ length: 8 }, (_, i) => `acting-${String(i + 1).padStart(2, '0')}`))
  const revive = seq('revive-recharge-v1/frames', [
    'revive-death-start', 'revive-wake', 'revive-lift',
    'revive-relief', 'revive-reopen', 'revive-settle', 'revive-hop',
  ])
  const criticalSeq = seq('feedback-expression-v4-r5-critical-model/frames', [
    'critical-notice', 'critical-brace', 'critical-overflow',
    'critical-peak', 'critical-comfort', 'critical-recover',
  ])

  // 疼痛反馈沿用原插件同一套帧（half/close/reopen 的 1250ms 节奏）。
  // 注意：顶层那批 `*-hands.png` 素材在原插件动画清单里完全没有被引用，
  // 单独播出来像「两个头」，这里一律不用。
  const painWeak = ['weak-half', 'weak-close', 'weak-half', 'weak-close', 'weak-half', 'weak-reopen'].map(r4).filter(has)
  const painNormal = ['normal-half', 'normal-close', 'normal-half', 'normal-close', 'normal-half', 'normal-reopen'].map(r4).filter(has)

  // 开心：新形象有专门的蹦跳帧（happy-01..04）；旧形象没有，沿用原来的眨眼三帧凑。
  const happyDedicated = seq('happy', ['happy-01', 'happy-02', 'happy-03', 'happy-04'])
  const happySeq = happyDedicated.length >= 3
    ? happyDedicated
    : ['blink-half-close', 'blink-soft', 'blink-half-close', 'blink-reopen']
      .map(n => `idle-v4-r2/${n}.png`)
      .filter(has)

  return {
    assetRoot: ASSET_ROOT,
    skin: SKIN.id,
    dragMode: DRAG_MODE,
    dragPose: USE_DRAG_POSE,
    idle: idle.length > 0 ? idle : pickExisting(['idle.png']),
    blink,
    acting,
    revive,
    criticalSeq,
    painWeak,
    painNormal,
    happySeq,
    states: {
      death: pickExisting(['death-stranded-v6-trim.png']),
      painCombo: pickExisting(['critical-combo-pain-v2.png']),
      draggedIdle: pickExisting(['idle-hands.png']),
    },
  }
}

/** 设置窗口要的「外观」这一块。集中在这里，免得各处自己拼。 */
function appState() {
  return {
    version: APP_VERSION,
    scale: Number(cfg.scale) || 1,
    skin: SKIN.id,
    alwaysOnTop: cfg.alwaysOnTop !== false,
    skins: SKINS.map(s => ({ id: s.id, label: s.label, desc: s.desc || '' })),
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
  const scale = Number(cfg.scale) || 1
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
  const scale = Number(cfg.scale) || 1
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
  // 托盘图标用形象里的一张成品帧；缺 top-level idle.png 时回落到 idle-v4-r2/idle-01.png，
  // 都没有就用空图标（宁可没图标，也不要因为图标丢了整个托盘）
  const candidates = [
    path.join(ASSET_ROOT, 'idle.png'),
    path.join(ASSET_ROOT, 'idle-v4-r2', 'idle-01.png'),
  ]
  let trayImg = nativeImage.createEmpty()
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      trayImg = nativeImage.createFromPath(p).resize({ width: 32, height: 32 })
      break
    }
  }
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
    width: 580,
    height: 760,
    minWidth: 460,
    minHeight: 460,
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
 */
function refreshUsage() {
  try {
    broadcastUsage(usage.poll().snapshot)
  } catch (err) {
    note('usage:poll-failed', { message: String((err && err.message) || err) })
  }
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
  const scale = Number(cfg.scale) || 1
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

    ipcMain.handle('frames', () => frameGroups())
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
      // 用来确认「事件 -> 渲染端 -> 受击动画」这条链路通不通（真实扣费等不来）。
      // WHALEPET_FAKE_LEVEL 可以指定等级（默认按金额推），用来逐个验收动画。
      const fakeHit = Number(process.env.WHALEPET_FAKE_HIT)
      if (Number.isFinite(fakeHit) && fakeHit > 0) {
        setTimeout(() => {
          if (win && !win.isDestroyed()) {
            const level = process.env.WHALEPET_FAKE_LEVEL || (fakeHit >= 3 ? 'critical' : (fakeHit >= 1 ? 'pain-normal' : 'pain-weak'))
            note('usage:fake-hit', { amount: fakeHit, level })
            win.webContents.send('usage-event', {
              source: 'workbuddy', amount: fakeHit, unit: 'credit', at: Date.now(), id: 'fake-hit', level,
            })
            // 抓帧按「事件」对齐，而不是按「启动后 N 秒」——冷启动耗时浮动，
            // 固定延时很容易抓空（实测两次相差 1.3 秒就完全错开了动画）。
            if (CAPTURING) {
              // 合并窗口 320ms + 动画进到第 2~3 帧。原来取 500ms 正好落在
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
