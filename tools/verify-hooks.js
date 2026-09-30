// tools/verify-hooks.js —— 设置窗口的验收钩子
//
// 只在 WHALEPET_CAPTURE=1 或 WHALEPET_PANEL_SELFTEST=1 时被 require。
// 单独放一个文件，是因为它跟窗口的功能一点关系都没有：留在 main.js 的
// openSettingsWindow() 里，主流程会被四十多行验收代码埋掉。
//
// 分工：main.js 传进 settingsWin 和两个能力（note 记事件、capture 抓窗口图），
// 这里只负责「什么时候抓、什么时候注入点击脚本」。
'use strict'

const CAPTURING = process.env.WHALEPET_CAPTURE === '1'
const SELFTEST = process.env.WHALEPET_PANEL_SELFTEST === '1'

/**
 * 设置窗口打开后挂验收钩子。不在验收模式下什么都不做。
 *
 * @param {BrowserWindow} win 设置窗口
 * @param {{ note: Function, capture: Function }} ctx
 *        note(step, extra) —— 写进 startup-report.json（WHALEPET_REPORT=1 时）
 *        capture(which, name, opt) —— 抓 'settings' / 'pet' 的窗口图到 tools/
 */
function attachPanelVerify(win, ctx) {
  if (!win || (!CAPTURING && !SELFTEST)) return
  const { note, capture } = ctx

  // 窗口自己那张图。和主窗口一样用 capturePage，免得为了验证还要在桌面上
  // 对准一个普通窗口去抓屏。
  if (CAPTURING) {
    win.webContents.once('did-finish-load', () => {
      capture('settings', 'settings-window.png', { wait: 2600 })
    })
  }
  if (!SELFTEST) return

  // 在窗口里**真点一遍按钮**（脚本见 tools/settings-selftest.js）。点真实 DOM 而不是
  // 直接调函数：只有点按钮才验得到事件绑定、异步 IPC 往返、以及回来之后的重新渲染。
  //
// 分三段跑，中间由主进程各抓图（面板 + 桌宠）。抓桌宠那几张才是关键 —— 在设置里
// 改了什么，最终要落到桌面上，那张图才是「选择生效了」的直接证据。
  win.webContents.once('did-finish-load', () => {
    let mod = null
    try {
      mod = require('./settings-selftest.js')
    } catch (err) {
      note('settings:selftest-error', { message: '读不到 tools/settings-selftest.js：' + String((err && err.message) || err) })
      return
    }

    /**
     * @param opt.petFirst 先抓桌宠再抓面板。**试演那一段必须这样**：动作只播一秒多，
     *                     而抓设置窗口本身要先等 900ms —— 等它抓完，桌宠早就回待机了。
     * @param opt.petWait  抓桌宠前等多久（等动作演到中段）
     */
    const run = (phase, script, panelShot, petShot, opt = {}) => {
      if (win.isDestroyed()) return Promise.resolve()
      const shotPanel = () => capture('settings', panelShot, { wait: opt.panelWait || 900 })
      const shotPet = () => capture('pet', petShot, { wait: opt.petWait || 3200 })
      return win.webContents.executeJavaScript(script, true)
        .then(res => note('settings:selftest', { phase, results: res }))
        .catch(err => note('settings:selftest-error', { phase, message: String((err && err.message) || err) }))
        .then(() => (opt.petFirst ? shotPet().then(shotPanel) : shotPanel().then(shotPet)))
    }

    setTimeout(() => {
      run('a', mod.PHASE_A, 'settings-selftest-a.png', 'bar-with-manual.png')
        .then(() => run('b', mod.PHASE_B, 'settings-selftest-b.png', 'bar-restored.png'))
        .then(() => run('c', mod.PHASE_C, 'settings-selftest-c.png', 'action-preview.png',
                        { petFirst: true, petWait: 420, panelWait: 200 }))
    }, 3200)
  })
}

module.exports = { attachPanelVerify }
