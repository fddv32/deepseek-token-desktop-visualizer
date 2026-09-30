// 设置窗口 preload —— 只暴露这个窗口需要的能力，不给 fs / require
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

/**
 * 约定：所有会改配置的调用都返回同一个形状 `{ app?, usage?, providers? }`
 * —— 只回被改动的那几块。渲染端只有这样才可以只写一遍合并逻辑。
 */
contextBridge.exposeInMainWorld('settings', {
  load: () => ipcRenderer.invoke('settings:load'),
  // 外观
  setScale: scale => ipcRenderer.invoke('settings:scale', scale),
  setSkin: id => ipcRenderer.invoke('settings:skin', id),
  setAlwaysOnTop: on => ipcRenderer.invoke('settings:ontop', on),
  // 信息条字段
  setFields: ids => ipcRenderer.invoke('settings:fields', ids),
  // 插件
  setInstalled: (id, on) => ipcRenderer.invoke('settings:install', id, on),
  deleteFile: id => ipcRenderer.invoke('settings:delete', id),
  reloadProviders: () => ipcRenderer.invoke('settings:reload'),
  openPluginsDir: () => ipcRenderer.invoke('settings:open-dir'),
  close: () => ipcRenderer.send('settings:close'),
  onUsage: fn => ipcRenderer.on('usage', (_e, snap) => fn(snap)),
})
