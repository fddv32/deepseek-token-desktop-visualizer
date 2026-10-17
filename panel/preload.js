// 用量面板 preload —— 只暴露这个窗口需要的能力，不给 fs / require。
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('panel', {
  // 首屏：一段历史 + 字段目录 + 当前配置
  load: () => ipcRenderer.invoke('panel:data'),
  // 字段增删。**复用设置窗口那两个 handler** —— 语义完全一样（都是"信息条显示哪些"），
  // 再开一个只会在两处各维护一遍校验。
  setFields: ids => ipcRenderer.invoke('settings:fields', ids),
  close: () => ipcRenderer.send('panel:close'),
  onUsage: fn => ipcRenderer.on('usage', (_e, snap) => fn(snap)),
})
