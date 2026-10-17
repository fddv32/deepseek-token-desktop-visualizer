// 鲸鱼娘桌宠渲染端 v5
//
// 拖动模式由主进程下发：
//   poll   —— 按下/松开各发一次 IPC，主进程按节拍跟随光标；移动期间零 IPC。（默认）
//   system —— #pet 加 .drag-region（-webkit-app-region: drag），窗口移动交给系统。
//             代价是这块区域可能收不到鼠标事件，交互判定要与之配合。
//
// 动画片段全部由主进程下发的动作清单（main.js 的 ACTIONS）现搭：每个动作带
// ms（每帧多久）和 frames（帧），**什么时候播**则由另一份时机名单决定
// （main.js 的 TRIGGERS -> groups.triggers，见 shared/triggers.js）。
// 这个文件里不写任何具体动作名，也不决定「双击播哪个」。
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
// 上一帧的落脚处（见 index.html 的说明）。它在 #pet 下面，只在切片段时露 90ms。
const prevImg = document.getElementById('pet-prev')
const BS = String.fromCharCode(92) // 反斜杠字符

const clips = new Map() // name -> { frames: [{url, ms}], loop, next }
let assetRoot = ''
let FRAME_VERSION = '' // 帧目录版本号（见 fileUrl）：素材更新后旧进程不再吃缓存旧帧
let dragMode = 'poll'
let useDragPose = false

// 动作清单由主进程下发（见 main.js 的 ACTIONS）。渲染端**不认识任何具体动作名**，
// 只有两处例外：
//   * 受击档位（weak / normal / critical）按位置去「扣费反应」名单里取动作
//   * 「试演」是按 id 点名
// 所以加动作、改「什么时候播哪个」都不用动这个文件。
//
// pools 是「时机 -> 能播的动作 id 列表」，整份来自主进程：
//   blink 偶尔眨眼（随机一个）· idle 待机随机（按权重）· click 双击（随机一个）
//   pet 单击摸摸（随机一个）· hit 扣费反应（**有序**，按档位取第 N 个）
let pools = { blink: [], idle: [], click: [], pet: [], hit: [] }
let idlePool = [] // 待机随机：带权重的 { id, weight }

let current = null // { name, index, frameStartedAt }
let nextBlinkAt = 0
let nextExtraAt = 0
let isDragging = false

function fileUrl(rel) {
  const clean = assetRoot.split(BS).join('/').replace(/\/+$/, '')
  const relPath = String(rel).split(BS).join('/')
  // ?v=帧目录的版本号：素材重新生成后同名文件的 file:// 缓存**不会失效**，
  // 运行中的桌宠会一直放旧帧（表现为「改了素材桌宠没变」）。版本号 = 帧目录的
  // 最新 mtime，进程生命周期内恒定（缓存照常命中），重启后版本变、缓存自然失效。
  return 'file:///' + clean + '/' + relPath + '?v=' + FRAME_VERSION
}

function firstOf(rels) {
  return Array.isArray(rels) && rels.length > 0 ? rels[0] : undefined
}

/**
 * 「一组相对路径 + 每帧时长」拼成帧表。
 * ms 给数组就逐帧用（长度不够时沿用最后一个），给数字就整段统一。
 */
function toFrames(rels, ms) {
  const list = Array.isArray(rels) ? rels : []
  const per = Array.isArray(ms) ? ms : null
  const flat = per ? (per[per.length - 1] || 160) : (ms || 160)
  return list.map((rel, i) => ({ url: fileUrl(rel), ms: per ? (per[i] || flat) : flat }))
}

/**
 * 按主进程下发的清单建片段 + 建各时机的池子。
 *
 * 片段名**就是动作 id**，这样「试演」可以直接按 id 点名，受击也能按名字查。
 * 但**播哪个**不看名字（名字里没有任何语义），看主进程给的那份名单：
 * 名单里放了谁，那个时机就会轮到谁。
 *
 * 没进任何名单的动作照样建片段（不建的话设置里的「试演」对没在用的动作就失灵了），
 * 只是没有任何池子会挑到它。
 */
function buildClips(groups) {
  assetRoot = groups.assetRoot || ''
  FRAME_VERSION = groups.frameVersion || ''
  const s = groups.states || {}
  const actions = Array.isArray(groups.actions) ? groups.actions : []
  const tr = groups.triggers || {}

  clips.clear()
  idlePool = []
  pools = { blink: [], idle: [], click: [], pet: [], hit: [] }

  const idle = toFrames(groups.idle, 160)
  if (idle.length > 0) clips.set('idle', { frames: idle, loop: true })

  // 名单先过一遍：换形象时名单里可能还留着这个素材里没有的动作，那就当它不存在 ——
  // 池子里放一个播不了的名字，用户看到的只是「点了没反应」，比报错还难查。
  const known = new Set(actions.map(a => a.id))
  const list = slot => (Array.isArray(tr[slot]) ? tr[slot] : []).filter(id => known.has(id))

  // 「扣费反应」是**有序**名单（从轻到重），最重的那笔用最后一个动作。
  // 暴击的尾巴（末帧定格一张「连续受击」的样子）挂在这个「最重的档」上，
  // 而不是挂在某个叫 critical 的动作上 —— 用户把那一档换成别的动作，尾巴要跟着走。
  const hitIds = list('hit')
  const heaviestHit = hitIds[hitIds.length - 1]

  for (const a of actions) {
    const frames = toFrames(a.frames, a.ms)
    if (frames.length === 0) continue
    if (a.id === heaviestHit && firstOf(s.painCombo)) {
      frames.push({ url: fileUrl(firstOf(s.painCombo)), ms: 500 })
    }
    clips.set(a.id, { frames, loop: false, next: 'idle' })
  }

  // 池子要等片段建完再筛一遍：上面只保证「名单里的动作有素材」，
  // 这里保证「真的建出了片段」（一张帧的动作不会建）。
  const pool = slot => list(slot).filter(id => clips.has(id))
  const weightOf = new Map(actions.map(a => [a.id, Math.max(1, a.weight || 1)]))
  pools.blink = pool('blink')
  pools.click = pool('click')
  pools.pet = pool('pet')
  pools.hit = pool('hit')
  pools.idle = pool('idle')
  idlePool = pools.idle.map(id => ({ id, weight: weightOf.get(id) || 1 }))

  const dragged = useDragPose ? firstOf(s.draggedIdle) : undefined
  if (dragged) clips.set('drag', { frames: [{ url: fileUrl(dragged), ms: 1000 }], loop: true })

  for (const def of clips.values()) {
    for (const frame of def.frames) {
      const img = new Image()
      img.src = frame.url
      // 顺手**解码**：只 preload 不 decode 的话，第一次播这一段时 Chromium 可能先画
      // 一帧空白（对透明窗口来说就是「闪一下白」）。decode() 失败不影响播放（有些
      // 环境不给解），所以吞掉异常。
      if (img.decode) img.decode().catch(() => {})
    }
  }
}

/** 从池子里随机挑一个（空池子返回空串）。 */
function pickFrom(ids) {
  return ids.length ? ids[Math.floor(Math.random() * ids.length)] : ''
}

/* 受击档位 -> 名单里的第几个。档位是金额算出来的轻重，和动作名无关。 */
const TIER_INDEX = { weak: 0, normal: 1, critical: 2 }

/**
 * 这一档该播哪个动作。
 *
 * 档位只有三档，名单里有几个就用几个 —— 名单短了（用户把「暴击」删了），
 * 最重的那笔就用最后一个动作。这样删动作不会让大额扣费变成「没反应」。
 */
function hitClipFor(tier) {
  if (pools.hit.length === 0) return ''
  const i = TIER_INDEX[tier] === undefined ? 0 : TIER_INDEX[tier]
  return pools.hit[Math.min(i, pools.hit.length - 1)]
}

/** 待机小动作池里按权重随机挑一个。池子空了返回空串。 */
function pickIdleExtra() {
  if (idlePool.length === 0) return ''
  let total = 0
  for (const it of idlePool) total += it.weight
  let r = Math.random() * total
  for (const it of idlePool) {
    r -= it.weight
    if (r <= 0) return it.id
  }
  return idlePool[idlePool.length - 1].id
}

/**
 * 片段切换：把**上一帧**留在下面淡出去，新帧叠在它上面（见 index.html / pet.css）。
 *
 * 为什么不是给 #pet 加一次淡入：窗口是透明的，`opacity` 一低就是「整只鱼半透明」，
 * 桌面背景透上来 —— 用户看到的就是「闪一下」。眨眼和打起精神都是一个片段进、一个片段出，
 * 各淡一次，所以这两个动作最明显。两层叠着做，两层的 opacity 都从 1 起跳，
 * 合成后任何一帧都不会出现半透明的那一瞬；顺带还盖住了「新帧没解码完先画一帧空白」。
 *
 * 必须在 `petImg.src = 新帧` **之前**调用（这儿先抓住旧 src）。
 */
function crossFadeFrom(prevSrc) {
  if (!prevImg || !prevSrc) return
  prevImg.src = prevSrc
  // 先把「不透明」这一态**立刻**定住：直接改 opacity 会被 90ms 的 transition 接住，
  // 于是从 0 淡到 1、再淡回 0 —— 那反而是一次闪烁。所以先摘掉 transition、强制一次
  // 重排把 opacity:1 提交下去，再恢复 transition 淡出。
  prevImg.style.transition = 'none'
  prevImg.style.opacity = '1'
  void prevImg.offsetWidth
  prevImg.style.transition = ''
  prevImg.style.opacity = '0'
}

function playClip(name) {
  const clip = clips.get(name)
  if (!clip) return false
  // 只有「换了一个片段」才交叉淡出。idle 自己重播（resumeIdle）时名字没变，不淡。
  const changing = !current || current.name !== name
  const prevSrc = changing ? petImg.getAttribute('src') : null
  current = { name, index: 0, frameStartedAt: performance.now() }
  petImg.src = clip.frames[0].url
  if (prevSrc) crossFadeFrom(prevSrc)
  return true
}

function scheduleIdleExtras(now) {
  // 眨眼排得密（两三秒一次，像呼吸）；随机小动作排得稀（十几秒到四十秒一次），
  // 否则桌宠会一刻不停地扭，看着烦而不是「活」。
  // 池子空就不排 —— 排了也是每几秒醒来一次白跑一遍。
  nextBlinkAt = pools.blink.length > 0 ? now + 2800 + Math.random() * 4200 : 0
  nextExtraAt = idlePool.length > 0 ? now + 14000 + Math.random() * 26000 : 0
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
      playClip(pickFrom(pools.blink))
      nextBlinkAt = 0
    } else if (nextExtraAt && now >= nextExtraAt) {
      const id = pickIdleExtra()
      if (id) playClip(id)
      nextExtraAt = 0
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
  // 不切「拎起帧」：这一版形象没有专门的被拎素材，drag 片段建不出来。
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
    // 双击播哪个由「双击」名单决定，随机挑一个 —— 名单空了就什么都不播
    const id = pickFrom(pools.click)
    if (id) {
      playClip(id)
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
      // 单击「摸摸」：播哪个由「单击摸摸」名单决定，随机挑一个；名单空了就不反应。
      // 默认名单借的是最轻的两档扣费反应 —— 这一版形象没有专门的「被摸」素材。
      const id = pickFrom(pools.pet)
      if (!id) return
      playClip(id)
      scheduleIdleExtras(performance.now() + 1200)
    }, 260)
  }
})

petImg.addEventListener('contextmenu', e => {
  e.preventDefault()
  window.whalePet.openMenu(e.clientX, e.clientY)
})

/* ---------- 扣费数字（用多少扣多少） ---------- */

const hitLayer = document.getElementById('hit')

/**
 * 每一笔账一个数字，主进程**不合并**（见 usage.js 的 decorateEvents）——
 * 所以这里要负责「怎么放」：排成队，一个出场完了再放下一个。
 *
 * 为什么必须排队：一次落盘常带十几条记录，同一瞬间全糊上去就只剩一团红字，
 * 什么都读不出来。隔 HIT_GAP_MS 放一个，看到的是一串 0.3、0.1、0.1……
 * 一笔一笔往下走 —— 这正是「钱在流出去」的样子。
 *
 * 它们是**竖着叠**的（CSS 里 flex-end 锚在鱼身上，新的从下面顶上来），
 * 所以不存在「两个数字撞在一起」的问题，也不需要横向错位。
 *
 * 节拍交给 shared/hitpacing.js —— 它只认时间、不碰 DOM，所以能被假时钟测出来。
 * 交给它的原因在那边写了：一次落盘回来的十几笔是**同一瞬间**到的，节拍必须挂在
 * 「上一次出场的时间」上，挂在「队列还剩没剩」上是无效的（每笔到场时队列都是空的）。
 */
const HIT_GAP_MS = 170
// 队列上限只防极端情况（一次 flush 回来几千条）把 DOM 堆爆。溢出时丢**最旧**的
// 并在控制台说一声 —— 丢的只是飘字，信息条上的「今日已用」该是多少还是多少。
const HIT_QUEUE_MAX = 40

const hitQueue = []

function popHit(ev) {
  const el = document.createElement('span')
  // 字号只跟**金额**走（`big` 由主进程按 meta.damage 的暴击线给出），跟播哪段动画、
  // 跟受击档位都无关 —— 档位可能是「按费用种类」定的（DSH 的未命中缓存很便宜但最疼），
  // 字号要是跟着档位，桌面上就会出现「最小的数字字最大」。
  // `heal`（充值复活）走绿色：扣血是红字，回血是绿字，一眼分得开。
  el.className = 'hit-num' + (ev.big ? ' big' : '') + (ev.heal ? ' heal' : '')
  el.textContent = (ev.heal ? '' : '-') + ev.hitValue
  if (ev.hitUnit) {
    const u = document.createElement('i')
    u.className = 'u'
    u.textContent = ev.hitUnit
    el.append(u)
  }
  hitLayer.append(el)
  // 动画 .95s（和 pet.css 的 hit-in 对齐，也就是它被下一批顶上去之前的一整段），
  // 多留 150ms 余量再摘，免得动画没播完元素就没了。
  // 摘的是**自己**：flex-end 下从栈顶（最旧的那行）消失，底下的行不会跳。
  setTimeout(() => el.remove(), 1100)
}

const hitPacer = HitPacing.createPacer({
  gap: HIT_GAP_MS,
  now: () => performance.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: id => clearTimeout(id),
  hasPending: () => hitQueue.length > 0,
  onEmit: () => popHit(hitQueue.shift()),
})

function queueHit(ev) {
  // 金额是 0 的账（比如只记了 token 没记钱的手动记账）不飘 —— 飘一个「-0」更糟
  if (!ev || !ev.hitValue || ev.hitValue === '0') return
  hitQueue.push(ev)
  while (hitQueue.length > HIT_QUEUE_MAX) {
    const drop = hitQueue.shift()
    console.warn('[whalepet] 飘字排队超过 ' + HIT_QUEUE_MAX + ' 笔，丢掉最旧的一笔 -' + drop.hitValue
      + '（今日已用的合计不受影响）')
  }
  hitPacer.arm()
}

/* ---------- 余额：充值 = 复活 ----------
 * 照 DSH 里那个 dsh-damage-pulse 插件的做法（它 15s 轮询一次余额，发现余额变多就
 * 飘绿色 +x 并播 revive-recharge）。我们这边余额本来就在快照里（fields 的「余额」
 * 那条 + snapshot.dsh.balance），所以不用另开轮询，比较前后两次就行。
 *
 * 为什么把「变多」当复活：扣血是只减不增的，余额唯一会涨的原因就是充值 ——
 * 那正是「从没血回到有血」，播「打起精神」最贴切（它本来就是一路亮起来）。
 * 顺带把还在闪的红闪停掉：刚充完值还红着不对劲。
 *
 * 只在**真的涨了**的时候动：余额接口抖动、四舍五入回退一点点都不算（允差 1e-9）。
 */
let lastBalance = null

function watchBalance(s) {
  const b = s && s.dsh && s.dsh.balance
  const v = b && b.available !== false && Number.isFinite(b.value) ? Number(b.value) : null
  if (v === null) return
  const prev = lastBalance
  lastBalance = v
  if (prev === null || v <= prev + 1e-9) return

  const gain = v - prev
  // 充值最少也是一分钱，用两位小数足矣；小额（测试/手动）保留三位免得显示成 +0.00
  const text = gain < 0.01 ? gain.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') : gain.toFixed(2)
  queueHit({ hitValue: text, hitUnit: (b.currency === 'CNY' || !b.currency) ? '元' : b.currency, heal: true })
  if (hurtTimer) { clearTimeout(hurtTimer); hurtTimer = null }
  petImg.classList.remove('hurt', 'crit', 'combo')
  playClip('revive')
}

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
  // 一个字段都没勾时把整条收起来。以前会留一个**空心的圆角框**（高度 95px）杵在
  // 鱼脚下：看着像界面坏了，而且它照占窗口高度、挡住底下的桌面点击。
  // （字段列表被清空是设置面板里勾掉全部字段的正常结果，不是错误状态。）
  const hidden = !off && fields.length === 0
  if (hidden) usageBox.classList.add('hidden')
  else usageBox.classList.remove('hidden')
  if (key === lastFieldsKey) return
  lastFieldsKey = key

  if (hidden) {
    Pills.empty(usageBox, '')
  } else if (off) {
    usageBox.classList.add('idle')
    Pills.empty(usageBox, '用量采集已关闭')
  } else {
    usageBox.classList.remove('idle')
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

// 同一波里连着来好几笔时，只播最重的那一次 —— 比较用的就是这个档位序号。
// （值取自 TIER_INDEX，别再抄一遍数字，否则改档位表时这里会被漏掉。）
const HIT_RANK = { weak: TIER_INDEX.weak + 1, normal: TIER_INDEX.normal + 1, critical: TIER_INDEX.critical + 1 }

function markActive() {
  usageBox.classList.remove('idle')
  if (idleTimer) clearTimeout(idleTimer)
  // 长时间没账就淡下去：常驻但不抢眼
  idleTimer = setTimeout(() => usageBox.classList.add('idle'), 45000)
}

/* ---------- 掉血：受击那一下的红闪 ----------
 * 数字由主进程算好（usage.js 的 hitOf，各来源量纲已归一成「血」），这一层只负责
 * 让鱼红一下 —— 见 pet.css 的 #pet.hurt。同一瞬间连着来几笔时，动画要能**重放**，
 * 所以先摘类、强制重排、再挂回去（不重排的话类名没变，动画不会重跑）。
 *
 * `ev.combo`（900ms 内连着两次重击）再叠一档：闪得更红更久，抖动也更大。
 */
let hurtTimer = null

function flashHurt(level, combo) {
  const crit = level === 'critical'
  petImg.classList.remove('hurt', 'crit', 'combo')
  void petImg.offsetWidth
  petImg.classList.add('hurt')
  if (crit) petImg.classList.add('crit')
  if (crit && combo) petImg.classList.add('combo')
  if (hurtTimer) clearTimeout(hurtTimer)
  hurtTimer = setTimeout(() => {
    hurtTimer = null
    petImg.classList.remove('hurt', 'crit', 'combo')
  }, crit ? (combo ? 480 : 380) : 240)
}

function onUsageEvent(ev) {
  markActive()
  usageBox.classList.add('pulse')
  setTimeout(() => usageBox.classList.remove('pulse'), 900)

  // 金额是 0 的账（比如只记了 token 没记钱）不掉血也不飘字 —— 飘一个「-0」更糟
  if (ev && ev.hitValue && ev.hitValue !== '0') flashHurt(ev.level, ev.combo)

  // 数字**立刻**进队，不等下面那个 320ms 的合并窗口：它是「这笔账花了多少」的收据，
  // 拖不拖动、有没有动画可播，都跟它没关系。（排队只是错开出场时间，见 queueHit。）
  queueHit(ev)

  const tier = ev && ev.level ? ev.level : 'weak'
  // 同一波里常连着来好几笔，只播最重的那一次，否则动画会被反复打断
  if (!pendingHit || (HIT_RANK[tier] || 0) > pendingRank) {
    pendingHit = tier
    pendingRank = HIT_RANK[tier] || 0
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
    // 档位 -> 动作：名单里没有能播的就直说（多半是用户在设置里把它清空了）
    const id = hitClipFor(lv)
    if (!id) {
      console.warn('[whalepet] 受击动画跳过：扣费反应名单里没有能播的动作（档位 ' + lv
        + '，已加载：' + Array.from(clips.keys()).join(',') + '）')
      return
    }
    // 正在播受击就让它播完，别互相盖 —— 「是不是受击动作」问的是名单，
    // 不是名字里有没有 pain（名字里没有语义）
    if (current && pools.hit.indexOf(current.name) >= 0) return
    playClip(id)
    scheduleIdleExtras(performance.now() + 1400)
  }, 320)
}

/* ---------- 启动 ---------- */

window.whalePet.onDragMode(applyDragMode)
window.whalePet.onUsage(s => { watchBalance(s); renderUsage(s) })
window.whalePet.onUsageEvent(onUsageEvent)

/**
 * 拉素材、重建片段。设置里开关动作时主进程会通知（actions-changed），走的是同一条路。
 *
 * 重建会把 clips 清空，正播着的那一段可能已经被关掉了 —— 所以统一回待机，
 * 不让它卡在一个已经没有帧的片段上。
 */
function loadClips() {
  return window.whalePet.listFrames().then(groups => {
    useDragPose = groups.dragPose === true
    applyDragMode(groups.dragMode)
    buildClips(groups)
    resumeIdle(performance.now())
  })
}

window.whalePet.onActionsChanged(() => { loadClips() })

// 设置里点「试演」：立刻播一次。播完 advance() 自己会回待机并重排定时器。
window.whalePet.onPreviewAction(id => {
  if (!clips.has(id)) {
    console.warn('[whalepet] 试演跳过：没有 ' + id + ' 片段（已加载：' + Array.from(clips.keys()).join(',') + '）')
    return
  }
  playClip(id)
  scheduleIdleExtras(performance.now() + 1400)
})

loadClips().then(() => requestAnimationFrame(tick))
