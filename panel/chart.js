// 每日用量的折线图。纯手写 SVG，不引图表库 ——
// 这个项目里所有图形（信息条、面板预览、飘字）都是手画 + CSS，多一个 200KB 的依赖
// 只为画一条折线不划算，而且样式也没法跟主题走。
//
// 三种量纲各画各的（token / 积分 / ¥），**不做换算** —— 换算要拍一个汇率，
// 那个数字一旦写进代码就会过时，还会让"我到底用了多少 token"变得答不上来。
//
// 挂到 window.Chart（不是 node 模块，只给面板用）。
'use strict'

;(function (root) {
  const NS = 'http://www.w3.org/2000/svg'
  const PAD = { t: 16, r: 14, b: 26, l: 52 }

  /** token 动辄上千万，坐标轴上得缩一下；金额很小，小数位要给够。 */
  function fmt(v, metric) {
    if (metric === 'cost') return v >= 100 ? v.toFixed(0) : v.toFixed(v < 1 ? 3 : 2)
    if (metric === 'credit') return v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v.toFixed(v < 10 ? 2 : 0)
    if (v >= 1e8) return (v / 1e8).toFixed(1) + '亿'
    if (v >= 1e4) return (v / 1e4).toFixed(v >= 1e6 ? 0 : 1) + '万'
    return String(Math.round(v))
  }

  /** 纵轴刻度：0 一定在里面，否则"零用量的一天"看着和"没数据"一样。 */
  function niceTicks(max, n) {
    if (!(max > 0)) return [0, 1]
    const raw = max / n
    const mag = Math.pow(10, Math.floor(Math.log10(raw)))
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || mag * 10
    const out = []
    for (let v = 0; v <= max + step * 0.001; v += step) out.push(v)
    return out
  }

  function el(name, attrs) {
    const e = document.createElementNS(NS, name)
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v)
    return e
  }

  /**
   * 画一张折线图。
   *   host   —— 容器元素（会被清空）
   *   rows   —— [{ label, tokens, credit, cost, calls }]，按日期升序
   *   metric —— 'tokens' | 'credit' | 'cost' | 'calls'
   */
  function line(host, rows, metric) {
    host.textContent = ''
    if (!rows || rows.length === 0) {
      const m = document.createElement('div')
      m.className = 'chart-empty'
      m.textContent = '还没有数据 —— 面板会从今天开始攒，用一阵子就有曲线了'
      host.appendChild(m)
      return
    }
    // 横轴文案：history.js 给的键是 'YYYY-MM-DD'，图上只留月/日
    for (const r of rows) if (!r.label) r.label = String(r.day || '').slice(5)

    const W = Math.max(320, host.clientWidth || 640)
    const H = Math.max(140, host.clientHeight || 200)
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: '100%' })
    const iw = W - PAD.l - PAD.r
    const ih = H - PAD.t - PAD.b

    const vals = rows.map(r => Number(r[metric]) || 0)
    const max = Math.max(...vals)
    const ticks = niceTicks(max, 4)
    const top = ticks[ticks.length - 1] || 1

    const x = i => PAD.l + (rows.length === 1 ? iw / 2 : (i / (rows.length - 1)) * iw)
    const y = v => PAD.t + ih - (v / top) * ih

    // 横向网格 + 纵轴刻度
    for (const t of ticks) {
      const gy = y(t)
      svg.appendChild(el('line', {
        x1: PAD.l, y1: gy, x2: PAD.l + iw, y2: gy,
        stroke: t === 0 ? 'var(--line-strong)' : 'var(--line)',
        'stroke-width': 1, 'stroke-dasharray': t === 0 ? '' : '3 4',
      }))
      const tx = el('text', {
        x: PAD.l - 8, y: gy + 4, 'text-anchor': 'end',
        fill: 'var(--muted)', 'font-size': '11',
      })
      tx.textContent = fmt(t, metric)
      svg.appendChild(tx)
    }

    // 折线 + 面积
    const pts = rows.map((r, i) => [x(i), y(Number(r[metric]) || 0)])
    const d = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ')
    const base = PAD.t + ih
    svg.appendChild(el('path', {
      d: `${d} L${pts[pts.length - 1][0].toFixed(1)} ${base} L${pts[0][0].toFixed(1)} ${base} Z`,
      fill: 'var(--accent-soft)', stroke: 'none',
    }))
    svg.appendChild(el('path', {
      d, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }))

    // 数据点：点少的时候画出来，点多了（30 天）就不画，免得糊成一条
    const showDots = rows.length <= 14
    pts.forEach((p, i) => {
      const v = Number(rows[i][metric]) || 0
      if (showDots || v > 0) {
        svg.appendChild(el('circle', {
          cx: p[0], cy: p[1], r: showDots ? 3 : 2,
          fill: 'var(--card)', stroke: 'var(--accent)', 'stroke-width': 2,
        }))
      }
    })

    // 横轴标签：最多标 8 个。**最后一个（今天）必须标**，但要防它和前一个挤在一起 ——
    // 30 天视图里出现过「10/010/02」糊成一坨，就是这两个点挨得太近。
    const step = Math.max(1, Math.ceil(rows.length / 8))
    const marks = []
    rows.forEach((r, i) => { if (i % step === 0) marks.push(i) })
    const lastIdx = rows.length - 1
    if (marks[marks.length - 1] !== lastIdx) {
      if (lastIdx - marks[marks.length - 1] < step * 0.6) marks.pop()
      marks.push(lastIdx)
    }
    for (const i of marks) {
      const tx = el('text', {
        x: x(i), y: H - PAD.b + 16, 'text-anchor': 'middle',
        fill: 'var(--muted)', 'font-size': '11',
      })
      tx.textContent = rows[i].label
      svg.appendChild(tx)
    }

    // 悬停：一根竖线 + 一个数
    const hover = el('line', {
      x1: 0, y1: PAD.t, x2: 0, y2: base,
      stroke: 'var(--accent)', 'stroke-width': 1, opacity: 0,
    })
    svg.appendChild(hover)
    const tip = document.createElement('div')
    tip.className = 'chart-tip'
    tip.style.display = 'none'
    host.appendChild(svg)
    host.appendChild(tip)

    const unit = metric === 'cost' ? '¥' : metric === 'credit' ? '积分' : metric === 'calls' ? '次' : 'token'
    svg.addEventListener('mousemove', ev => {
      const box = svg.getBoundingClientRect()
      const px = ((ev.clientX - box.left) / box.width) * W
      let near = 0
      let best = Infinity
      pts.forEach((p, i) => {
        const dist = Math.abs(p[0] - px)
        if (dist < best) { best = dist; near = i }
      })
      const p = pts[near]
      hover.setAttribute('x1', p[0])
      hover.setAttribute('x2', p[0])
      hover.setAttribute('opacity', 0.5)
      const v = Number(rows[near][metric]) || 0
      tip.textContent = rows[near].label + '  ' + fmt(v, metric) + ' ' + unit
      tip.style.display = 'block'
      tip.style.left = Math.min(Math.max(p[0] / W * box.width, 60), box.width - 60) + 'px'
      tip.style.top = Math.max(4, p[1] / H * box.height - 34) + 'px'
    })
    svg.addEventListener('mouseleave', () => {
      hover.setAttribute('opacity', 0)
      tip.style.display = 'none'
    })
  }

  root.Chart = { line, fmt }
}(typeof window !== 'undefined' ? window : globalThis))
