// 把 usage 快照里的字段列表画成胶囊。
//
// 桌宠信息条和「设置」窗口的预览共用这一份 —— 两处各写一遍渲染逻辑，
// 结果必然是改了一处忘了另一处（这正是抽出来的原因）。
//
// 关键约定：**这里不做任何格式化**。每个字段的 label / value / tone 都是主进程
// （usage.js）算好的，渲染端只负责画。所以面板预览和桌面上的信息条不可能不一致。
'use strict'

;(function () {
  function span(cls, text) {
    const el = document.createElement('span')
    el.className = cls
    el.textContent = text
    return el
  }

  window.Pills = {
    /**
     * 把 fields 画进 box。box 自身要是 .pillbar 容器（样式见 shared/pills.css）。
     *
     * 字段的形态（都由主进程算好，这里不做任何判断）：
     *   { id, label?, value, unit?, tone?, title? }
     * unit 是数字后面那个小字（「5.47 积分」/「132.5万 token」），字号更小、颜色更淡 ——
     * 读数字的时候它不抢眼，需要的时候又在那儿。
     *
     * @returns {number} 画出来的胶囊数（0 = 一个字段都没有）
     */
    render(box, fields) {
      box.textContent = ''
      let n = 0
      for (const f of fields || []) {
        if (!f || f.id == null) continue
        const pill = span('pill' + (f.tone ? ' t-' + f.tone : ''), '')
        if (f.title) pill.title = f.title
        if (f.label) pill.append(span('lb', f.label))
        const num = span('nm', f.value == null ? '--' : String(f.value))
        if (f.unit) {
          const v = span('vl', '')
          v.append(num, span('un', f.unit))
          pill.append(v)
        } else {
          pill.append(num)
        }
        box.append(pill)
        n += 1
      }
      return n
    },

    /** 没有任何字段可显示时的占位胶囊（面板预览用）。 */
    empty(box, text) {
      box.textContent = ''
      const pill = span('pill t-off', '')
      pill.append(span('nm', text))
      box.append(pill)
    },

    /**
     * 内容指纹。信息条每 2.5 秒推一次快照，字段没变就别重建 DOM ——
     * 重建会让 title 浮层闪一下，也白费电。
     */
    key(fields) {
      return (fields || []).map(f => f.id + '|' + f.value + '|' + f.unit + '|' + f.tone).join(';')
    },
  }
})()
