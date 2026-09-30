// 鲸鱼娘桌宠 preload v5
// 拖动模式由主进程推给渲染端：system 模式用 CSS 系统拖动，poll 模式走 drag-start/drag-end。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('whalePet', {
  listFrames: () => ipcRenderer.invoke('frames'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  savePos: () => ipcRenderer.send('save-pos'),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragEnd: () => ipcRenderer.send('drag-end'),
  openMenu: (x, y) => ipcRenderer.send('open-menu', x, y),
  // 信息条字段可配置 → 高度会变 → 渲染端量完回报，主进程保持底边不动地长窗口
  setBarHeight: h => ipcRenderer.send('usage:bar-height', h),
  onScaleChanged: fn => ipcRenderer.on('scale-changed', (_e, s) => fn(s)),
  onTopChanged: fn => ipcRenderer.on('ontop-changed', (_e, on) => fn(on)),
  onDragMode: fn => ipcRenderer.on('drag-mode', (_e, mode) => fn(mode)),
  onUsage: fn => ipcRenderer.on('usage', (_e, snap) => fn(snap)),
  onUsageEvent: fn => ipcRenderer.on('usage-event', (_e, ev) => fn(ev)),
})
