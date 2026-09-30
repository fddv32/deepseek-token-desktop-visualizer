// tools/settings-selftest.js —— 设置窗口的点击验收脚本
//
// 由 main.js 在 WHALEPET_PANEL_SELFTEST=1 时**注入到设置窗口里执行**。
// 刻意点真实 DOM 按钮而不是直接调函数：只有点按钮才验得到事件绑定、
// 异步 IPC 往返、以及回来之后的重新渲染 —— 直接调函数这三样全都验不到。
//
// 分两段跑，中间由主进程各抓一张图（面板 + 桌宠）：
//   a：外观（大小 / 形象）＋ 把「手动记账」字段加到信息条上并上移一位
//      -> 用来截图看它真的出现了
//   b：摘掉字段、卸载/安装插件、重载插件、检查「关于」，逐项断言 -> 跑完回到原样
//
// 注意：脚本要经过 executeJavaScript 传进渲染端，所以整段是**字符串**。
// 里面不能出现反引号或 ${，否则会和本文件的外层模板字符串打架。
'use strict'

const HELPERS = `
  const out = [];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const chips = () => Array.from(document.querySelectorAll('.chip-add'));
  const rows = () => Array.from(document.querySelectorAll('#field-on .field-row'));
  const rowName = r => { const n = r.querySelector('.nm'); return n ? n.textContent : ''; };
  const names = () => rows().map(rowName);
  const chip = t => chips().find(b => b.textContent.indexOf(t) >= 0);
  const rowOf = t => rows().find(r => rowName(r).indexOf(t) >= 0);
  const card = t => Array.from(document.querySelectorAll('#providers .plugin'))
    .find(c => { const n = c.querySelector('.name'); return n && n.textContent === t; });
  const txt = id => { const e = document.getElementById(id); return e ? e.textContent : ''; };
  const check = (name, ok, detail) => out.push({ step: name, ok: !!ok, detail: String(detail === undefined ? '' : detail) });
  async function click(el) {
    if (!el) return false;
    el.click();
    await sleep(500);
    return true;
  }
`

/** a 段：外观 + 加字段 + 上移。 */
const PHASE_A = `(async () => {${HELPERS}
  // ---- 外观：大小 / 形象 ----
  const segs = Array.from(document.querySelectorAll('#scale button'));
  check('大小有三档', segs.length === 3, segs.map(b => b.textContent).join(' / '));
  const mid = segs.find(b => b.textContent === '中');
  check('当前是「中」且被高亮', !!mid && mid.classList.contains('on'), txt('scale-hint'));

  await click(segs.find(b => b.textContent === '大'));
  check('点「大」之后提示变成 140%', txt('scale-hint').indexOf('140') >= 0, txt('scale-hint'));
  await click(segs.find(b => b.textContent === '中'));
  check('点回「中」之后恢复 100%', txt('scale-hint').indexOf('100') >= 0, txt('scale-hint'));

  const skins = Array.from(document.querySelectorAll('#skins .chip-pick'));
  check('形象有 ' + skins.length + ' 个可选', skins.length >= 2, skins.map(b => b.textContent).join(' / '));
  check('恰好一个形象处于选中态', skins.filter(b => b.classList.contains('on')).length === 1,
        skins.filter(b => b.classList.contains('on')).map(b => b.textContent).join(','));

  // ---- 信息条字段 ----
  const LABEL = '手动记账';
  check('起始有 ' + rows().length + ' 行', rows().length > 0, names().join(' / '));

  const add = chip(LABEL);
  check('可添加字段里有「' + LABEL + '」' + (add ? '' : ' —— 用户插件没被识别'), !!add);
  if (add) {
    await click(add);
    check('点 ＋ 之后它出现在信息条字段里', names().some(n => n.indexOf(LABEL) >= 0), names().join(' / '));
    const i0 = names().findIndex(n => n.indexOf(LABEL) >= 0);
    const up = rowOf(LABEL) && rowOf(LABEL).querySelectorAll('.ops button')[0];
    await click(up);
    const i1 = names().findIndex(n => n.indexOf(LABEL) >= 0);
    check('点 ↑ 之后它上移了一位', i1 === i0 - 1, i0 + ' -> ' + i1 + '  [' + names().join(' / ') + ']');

    // 预览必须跟着动，而不是等下一轮轮询 —— 早先这里会慢 2.5s，看着像点了没反应
    const pv = Array.from(document.querySelectorAll('#preview .pill')).map(s => s.textContent);
    const iPv = pv.findIndex(t => t.indexOf(LABEL) >= 0);
    check('预览的顺序立刻跟上了', iPv === i1, '行 ' + i1 + ' / 预览 ' + iPv + '  [' + pv.join(' | ') + ']');
  }

  // 抓这张图时让字段列表在视野里
  const first = document.querySelector('#field-on .field-row');
  if (first) { first.scrollIntoView({ block: 'start' }); await sleep(400); }
  return out;
})()`

/** b 段：摘掉字段 + 卸载/安装 + 重载 + 关于。 */
const PHASE_B = `(async () => {${HELPERS}
  const LABEL = '手动记账';

  const row = rowOf(LABEL);
  const x = row && row.querySelectorAll('.ops button')[2];
  check('信息条上有「' + LABEL + '」这一行', !!row);
  if (x) {
    await click(x);
    check('点 × 之后它从信息条上消失', !names().some(n => n.indexOf(LABEL) >= 0), names().join(' / '));
    check('它回到「可添加字段」里', !!chip(LABEL));
  }

  // ---- 插件：卸载 / 安装 ----
  const c = card(LABEL);
  check('插件卡片存在', !!c);
  if (c) {
    check('标着「用户插件」', c.textContent.indexOf('用户插件') >= 0);
    const acts = Array.from(c.querySelectorAll('.acts button')).map(b => b.textContent);
    check('卡片上有「卸载」', acts.indexOf('卸载') >= 0, acts.join(' / '));
    check('用户插件还有「删除文件」', !!c.querySelector('.acts button.danger'), acts.join(' / '));

    await click(Array.from(c.querySelectorAll('.acts button')).find(b => b.textContent === '卸载'));
    const c1 = card(LABEL);
    check('卸载后卡片显示「已卸载」', !!c1 && c1.textContent.indexOf('已卸载') >= 0,
          c1 ? c1.textContent.replace(/\\s+/g, ' ').slice(0, 70) : '卡片没了');
    check('卸载后它的字段从「可添加字段」里消失', !chip(LABEL));
    check('卡片上变成「安装」按钮', Array.from((c1 || document).querySelectorAll('.acts button'))
          .some(b => b.textContent === '安装'));

    await click(Array.from(card(LABEL).querySelectorAll('.acts button')).find(b => b.textContent === '安装'));
    check('重新安装后字段回到「可添加字段」里', !!chip(LABEL));
  }

  // ---- 重载 ----
  const reloadBtn = document.getElementById('btn-reload');
  check('有「重载插件」按钮', !!reloadBtn);
  if (reloadBtn) {
    await click(reloadBtn);
    check('重载后插件还在（没被误删）', !!card(LABEL));
    check('重载后没有加载错误', document.getElementById('plugin-errors').classList.contains('hidden'));
  }

  // ---- 关于 ----
  check('关于里显示版本号', /^v\\d+\\.\\d+/.test(txt('version')), txt('version'));
  const src = Array.from(document.querySelectorAll('#about-sources .source'));
  check('关于里列出了每个数据源（' + src.length + ' 个）', src.length === document.querySelectorAll('#providers .plugin').length,
        src.map(s => s.textContent.replace(/\\s+/g, ' ')).join(' | ').slice(0, 120));
  check('关于里写明了当前形象', txt('cur-skin').indexOf('当前形象') >= 0, txt('cur-skin'));

  out.push({ step: '最终字段', ok: true, detail: names().join(' / ') });

  // 滚到用户插件那张卡片上，这样紧接着抓的那张图里能看到它的操作按钮
  const c3 = card(LABEL);
  if (c3) { c3.scrollIntoView({ block: 'center' }); await sleep(500); }
  return out;
})()`

module.exports = { PHASE_A, PHASE_B }
