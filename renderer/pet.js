// 鲸鱼娘桌宠渲染端 v5
//
// 拖动模式由主进程下发：
//   poll   —— 按下/松开各发一次 IPC，主进程按节拍跟随光标；移动期间零 IPC。（默认）
//   system —— #pet 加 .drag-region（-webkit-app-region: drag），窗口移动交给系统。
//             代价是这块区域可能收不到鼠标事件，交互判定要与之配合。
//
// 素材只用原插件同一套、经过验证的帧；顶层那批 `*-hands.png` 是原插件清单里没引用的
// 废弃素材，单独播放会像「两个头」，这里一律不碰。
'use strict'

// 渲染端的异常默认是「静默」的：脚本一抛错就整段停摆，桌面上的表现只是
// 「图没出来、数字停在 --」，看不到任何提示。把异常桥成 console.error，
// 再由主进程（WHALEPET_REPORT=1 时）记进启动报告，省得下次又靠猜。
window.addEventListener('error', ev => {
  console.error('[whalepet] uncaught: ' + ev.message + ' @ ' + ev.filename + ':' + ev.lineno)
})
window.addEventListener('unhandledrejection', ev => {
  const r = ev.reason
  console.error('[whalepet] unhandled rejection: ' + ((r && r.message) || r))
})

const petImg = document.getElementById('pet')
const BS = String.fromCharCode(92) // 反斜杠字符

const clips = new Map() // name -> { frames: [{url, ms}], loop, next }
let assetRoot = ''
let dragMode = 'poll'
let useDragPose = false

// 疼痛反馈的帧时长（对齐原插件 1250ms 的 half/close/reopen 节奏）
const PAIN_MS = [150, 470, 70, 100, 80, 80]
// 摸头的开心反馈：闭眼 -> 笑眯眯 -> 睁眼
const HAPPY_MS = [155, 825, 80, 85]

let current = null // { name, index, frameStartedAt }
let nextBlinkAt = 0
let nextActingAt = 0
let isDragging = false

function fileUrl(rel) {
  const clean = assetRoot.split(BS).join('/').replace(/\/+$/, '')
  const relPath = String(rel).split(BS).join('/')
  return 'file:///' + clean + '/' + relPath
}

function firstOf(rels) {
  return Array.isArray(rels) && rels.length > 0 ? rels[0] : undefined
}

function toFrames(rels, ms) {
  const list = Array.isArray(rels) ? rels : []
  return list.map(rel => ({ url: fileUrl(rel), ms: ms || 160 }))
}

function withDurations(rels, durations) {
  const list = Array.isArray(rels) ? rels : []
  const fallback = durations[durations.length - 1] || 160
  return list.map((rel, index) => ({ url: fileUrl(rel), ms: durations[index] || fallback }))
}

function buildClips(groups) {
  assetRoot = groups.assetRoot || ''
  const s = groups.states || {}

  const defs = {
    idle: { frames: toFrames(groups.idle, 160), loop: true },
    blink: { frames: toFrames(groups.blink, 140), loop: false, next: 'idle' },
    acting: { frames: toFrames(groups.acting, 170), loop: false, next: 'idle' },
    revive: { frames: toFrames(groups.revive, 340), loop: false, next: 'idle' },
    critical: {
      frames: [
        ...toFrames(groups.criticalSeq, 260),
        ...(firstOf(s.painCombo) ? [{ url: fileUrl(firstOf(s.painCombo)), ms: 500 }] : []),
      ],
      loop: false,
      next: 'idle',
    },
    'pain-weak': { frames: withDurations(groups.painWeak, PAIN_MS), loop: false, next: 'idle' },
    'pain-normal': { frames: withDurations(groups.painNormal, PAIN_MS), loop: false, next: 'idle' },
    happy: { frames: withDurations(groups.happySeq, HAPPY_MS), loop: false, next: 'idle' },
  }
  const dragged = useDragPose ? firstOf(s.draggedIdle) : undefined
  if (dragged) defs.drag = { frames: [{ url: fileUrl(dragged), ms: 1000 }], loop: true }

  for (const [name, def] of Object.entries(defs)) {
    if (def.frames.length > 0) clips.set(name, def)
  }

  for (const def of clips.values()) {
    for (const frame of def.frames) {
      const img = new Image()
      img.src = frame.url
    }
  }
}

function playClip(name) {
  const clip = clips.get(name)
  if (!clip) return false
  current = { name, index: 0, frameStartedAt: performance.now() }
  petImg.src = clip.frames[0].url
  return true
}

function scheduleIdleExtras(now) {
  if (clips.has('blink')) nextBlinkAt = now + 2800 + Math.random() * 4200
  if (clips.has('acting')) nextActingAt = now + 18000 + Math.random() * 37000
}

function advance(now) {
  if (!current) return
  const clip = clips.get(current.name)
  if (!clip) { current = null; return }
  const frame = clip.frames[current.index]
  if (!frame) return
  if (now - current.frameStartedAt < frame.ms) return

  current.index += 1
  current.frameStartedAt += frame.ms
  if (current.index >= clip.frames.length) {
    if (clip.loop) {
      current.index = 0
    } else {
      playClip(clip.next || 'idle')
      scheduleIdleExtras(performance.now())
      return
    }
  }
  petImg.src = clip.frames[current.index].url
}

function resumeIdle(now) {
  if (!playClip('idle')) return
  scheduleIdleExtras(now)
}

function tick(now) {
  if (current && current.name === 'idle' && !isDragging) {
    if (nextBlinkAt && now >= nextBlinkAt) {
      playClip('blink')
      nextBlinkAt = 0
    } else if (nextActingAt && now >= nextActingAt) {
      playClip('acting')
      nextActingAt = 0
    }
  }
  advance(now)
  requestAnimationFrame(tick)
}

/* ---------- 拖动 ---------- */

function applyDragMode(mode) {
  dragMode = mode === 'system' ? 'system' : 'poll'
  // 只有 system 模式让系统接管这块区域；poll 模式必须保持普通可点区域。
  petImg.classList.toggle('drag-region', dragMode === 'system')
}

function enterDragging() {
  if (isDragging) return
  isDragging = true
  petImg.classList.add('dragging')
  // 默认不切「拎起帧」：那套 idle-hands 姿势在桌宠尺寸下会被看成两个头。
  // 拖动期间保持待机循环（tick 里会暂停眨眼/小动作），视觉上干净。
  if (useDragPose && clips.has('drag')) playClip('drag')
}

function leaveDragging(now) {
  if (!isDragging) return
  isDragging = false
  petImg.classList.remove('dragging')
  resumeIdle(now)
}

/* ---------- 交互 ---------- */

let mouseDown = false
let dragArmed = false
let downAt = 0
let lastX = 0
let lastY = 0
let accum = 0
let clickTimer = null
let downCount = 0
let downTimer = null
let dragFrameTimer = null
let dragWatchdog = null

function armDragFrameLater() {
  // system 模式下拖拽区收不到 mousemove，靠「按住一小会儿」来判定拎起
  if (dragFrameTimer) clearTimeout(dragFrameTimer)
  dragFrameTimer = setTimeout(() => {
    dragFrameTimer = null
    if (mouseDown && !dragArmed) {
      dragArmed = true
      enterDragging()
    }
  }, 130)
}

function resetDownState() {
  mouseDown = false
  dragArmed = false
  if (dragFrameTimer) { clearTimeout(dragFrameTimer); dragFrameTimer = null }
  if (dragWatchdog) { clearTimeout(dragWatchdog); dragWatchdog = null }
}

petImg.addEventListener('mousedown', e => {
  if (e.button !== 0) return
  const now = performance.now()

  // 双击自判：300ms 内第二次按下 -> 开心
  downCount += 1
  if (downCount >= 2) {
    downCount = 0
    if (downTimer) { clearTimeout(downTimer); downTimer = null }
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null }
    resetDownState()
    petImg.classList.remove('dragging')
    isDragging = false
    if (clips.has('happy')) {
      playClip('happy')
      scheduleIdleExtras(performance.now() + 1200)
    }
    return
  }
  if (downTimer) clearTimeout(downTimer)
  downTimer = setTimeout(() => { downCount = 0; downTimer = null }, 300)

  mouseDown = true
  dragArmed = false
  downAt = now
  lastX = e.screenX
  lastY = e.screenY
  accum = 0
  armDragFrameLater()
  if (dragMode === 'poll') window.whalePet.dragStart()
  if (dragWatchdog) clearTimeout(dragWatchdog)
  dragWatchdog = setTimeout(() => { if (mouseDown) endDrag(performance.now()) }, 8000)
})

window.addEventListener('mousemove', e => {
  if (!mouseDown) return
  const dx = e.screenX - lastX
  const dy = e.screenY - lastY
  lastX = e.screenX
  lastY = e.screenY
  accum += Math.abs(dx) + Math.abs(dy)
  if (!dragArmed && accum > 6) {
    dragArmed = true
    enterDragging()
  }
})

function endDrag(now) {
  const wasArmed = dragArmed
  resetDownState()
  if (dragMode === 'poll') {
    window.whalePet.dragEnd()
  } else {
    window.whalePet.savePos()
  }
  leaveDragging(now)
  return wasArmed
}

window.addEventListener('mouseup', e => {
  if (e.button !== 0 || !mouseDown) return
  const now = performance.now()
  const dragged = endDrag(now)

  if (dragged) return
  // 未拖动：单击（延迟 260ms 等第二次按下判双击）
  if (now - downAt < 450) {
    if (clickTimer) return
    clickTimer = setTimeout(() => {
      clickTimer = null
      const name = Math.random() < 0.6 ? 'pain-weak' : 'pain-normal'
      playClip(clips.has(name) ? name : 'idle')
      scheduleIdleExtras(performance.now() + 1200)
    }, 260)
  }
})

petImg.addEventListener('contextmenu', e => {
  e.preventDefault()
  window.whalePet.openMenu(e.clientX, e.clientY)
})

/* ---------- 用量信息条 ---------- */

const usageBox = document.getElementById('usage')

// 信息条上也要能右键出菜单，否则鼠标挪到下面按右键没反应会很别扭。
usageBox.addEventListener('contextmenu', e => {
  e.preventDefault()
  window.whalePet.openMenu(e.clientX, e.clientY)
})

/**
 * 按主进程给的字段列表画信息条。
 *
 * 画法在 shared/pills.js 里（和「设置」里的预览同一份），这里只负责：
 * 决定要不要重画、更新整条的 title 提示、然后回报高度。
 *
 * 刻意**不做任何格式化**：label / value / tone 全是主进程算好的（见 usage.js），
 * 上一版把百分比在渲染端又算了一遍，改了阈值忘了同步，就是这么来的。
 */
let lastFieldsKey = ''

function renderUsage(s) {
  const off = !s || s.disabled
  const fields = off ? [] : (s.fields || [])
  const key = off ? '#off' : Pills.key(fields)
  if (key === lastFieldsKey) return
  lastFieldsKey = key

  if (off) {
    usageBox.classList.add('idle')
    Pills.empty(usageBox, '用量采集已关闭')
  } else {
    Pills.render(usageBox, fields)
    usageBox.title = fields.map(f => f.title).filter(Boolean).join('\n')
    markActive()
  }
  reportBarHeight()
}

/**
 * 量出信息条的真实高度回报给主进程。
 * 字段是可配置的，勾多了会换行变高，窗口必须跟着变 —— 否则要么数字被裁掉，
 * 要么底下空一大块挡住桌面的点击。
 *
 * 只在值变化时发，而且等一帧再量（DOM 刚改完，立刻量到的是旧布局）。
 */
let lastReportedH = 0

function reportBarHeight() {
  requestAnimationFrame(() => {
    const rect = usageBox.getBoundingClientRect()
    // bottom:6px + 上下各 6px 余量
    const h = Math.ceil(rect.height) + 12 + 6
    if (Math.abs(h - lastReportedH) < 2) return
    lastReportedH = h
    // 同步改 --usage-h，#pet 的 max-height 靠它让位；不用等主进程回包
    document.documentElement.style.setProperty('--usage-h', h + 'px')
    window.whalePet.setBarHeight(h)
  })
}

/* ---------- 扣费受击 ---------- */

// 各来源量纲差得远（credit / 人民币 / token），阈值全部由主进程按插件配好，
// 事件里直接带 level —— 渲染端不做任何业务判断，只管播哪个片段。
let pendingHit = null
let pendingRank = 0
let hitTimer = null
let idleTimer = null

const HIT_RANK = { 'pain-weak': 1, 'pain-normal': 2, critical: 3 }

function markActive() {
  usageBox.classList.remove('idle')
  if (idleTimer) clearTimeout(idleTimer)
  // 长时间没账就淡下去：常驻但不抢眼
  idleTimer = setTimeout(() => usageBox.classList.add('idle'), 45000)
}

function onUsageEvent(ev) {
  markActive()
  usageBox.classList.add('pulse')
  setTimeout(() => usageBox.classList.remove('pulse'), 900)

  const level = ev && ev.level ? ev.level : 'pain-weak'
  // 同一波里常连着来好几笔，只播最重的那一次，否则动画会被反复打断
  if (!pendingHit || (HIT_RANK[level] || 0) > pendingRank) {
    pendingHit = level
    pendingRank = HIT_RANK[level] || 0
  }
  if (hitTimer) clearTimeout(hitTimer)
  hitTimer = setTimeout(() => {
    hitTimer = null
    const lv = pendingHit
    pendingHit = null
    pendingRank = 0
    if (!lv) return
    // 这几条「静默跳过」以前什么都不说，动画不播就只能靠猜。改成明确告警，
    // 配合 WHALEPET_REPORT=1 会进 startup-report.json 的 renderer:console。
    if (isDragging) { console.warn('[whalepet] 受击动画跳过：正在拖动'); return }
    if (!clips.has(lv)) {
      console.warn('[whalepet] 受击动画跳过：没有 ' + lv + ' 片段（已加载：' + Array.from(clips.keys()).join(',') + '）')
      return
    }
    // 正在播受击就让它播完，别互相盖
    if (current && (current.name === 'critical' || String(current.name).indexOf('pain') === 0)) return
    playClip(lv)
    scheduleIdleExtras(performance.now() + 1400)
  }, 320)
}

/* ---------- 启动 ---------- */

window.whalePet.onDragMode(applyDragMode)
window.whalePet.onUsage(renderUsage)
window.whalePet.onUsageEvent(onUsageEvent)

window.whalePet.listFrames().then(groups => {
  useDragPose = groups.dragPose === true
  applyDragMode(groups.dragMode)
  buildClips(groups)
  resumeIdle(performance.now())
  requestAnimationFrame(tick)
})
