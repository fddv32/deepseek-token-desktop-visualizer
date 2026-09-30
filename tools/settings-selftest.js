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
//   c：动作页（按时机分组）—— 去掉 / 加回 / 排序 / 试演，跑完也回到原样
//
// 「跑完回到原样」不是客套：验收会真的改用户配置（挪动作、摘字段），
// 收尾没做干净，用户下次打开面板会发现自己的选择被改掉了。
//
// 面板是**分页**的（左侧导航：外观 / 桌宠上显示 / 动作 / 数据源插件 / 关于）。
// 所以每段开头都要先 go() 到目标页：
//   * 断言读的是 DOM，隐藏页里的元素照样读得到 —— 不切页断言也不会假失败；
//   * 但**截图**只看得到当前页，不切页就会拍到「外观」而报告里写着在验插件，
//     那种绿是最坏的一种绿。
//   * 顺带也就验到了导航本身（切页靠点真实按钮）。
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
  // 左侧导航：点真实按钮切页（不是直接调 showPage，那样验不到事件绑定）。
  // 返回前确认目标页**真的显示了**（offsetParent !== null 排除了 display:none）——
  // 只看导航项高亮是不够的：高亮和页面显隐是两件事，页面容器没接上时前者照样对。
  const navs = () => Array.from(document.querySelectorAll('.nav-item'));
  const curPage = () => { const b = navs().find(x => x.classList.contains('on')); return b ? b.dataset.page : ''; };
  const pageShown = id => { const p = document.getElementById('page-' + id); return !!p && p.offsetParent !== null; };
  async function go(id) {
    const b = navs().find(x => x.dataset.page === id);
    if (!b) return false;
    if (!b.classList.contains('on')) await click(b);
    return curPage() === id && pageShown(id);
  }
`

/** a 段：外观 + 加字段 + 上移。 */
const PHASE_A = `(async () => {${HELPERS}
  // ---- 左侧导航本身 ----
  check('左侧导航有 ' + navs().length + ' 项', navs().length === 5, navs().map(b => b.textContent.trim()).join(' / '));
  check('能切到「外观」页', await go('look'), curPage());
  check('切页后导航项有选中态', navs().filter(b => b.classList.contains('on')).length === 1,
        navs().map(b => (b.classList.contains('on') ? '[' + b.dataset.page + ']' : b.dataset.page)).join(' / '));
  check('只显示当前这一页', document.querySelectorAll('.page').length === 5
        && document.querySelectorAll('.page.on').length === 1,
        document.querySelectorAll('.page.on').length + ' 页可见');
  // 计数徽标挂在导航项上，一栏就能看到各页状态
  check('导航项带计数徽标', !!txt('action-count') && !!txt('plugin-count'),
        '动作 ' + txt('action-count') + ' / 插件 ' + txt('plugin-count'));

  // ---- 外观：大小 / 形象 ----
  // 注意：这里**不能假设起始是「中」**。大小是用户自己的配置（可能是 0.7），
  // 脚本改完必须点回原来那一档，否则跑一次验收就把用户的桌宠尺寸改掉了。
  const segs = Array.from(document.querySelectorAll('#scale button'));
  check('大小有三档', segs.length === 3, segs.map(b => b.textContent).join(' / '));
  const curScale = segs.find(b => b.classList.contains('on'));
  check('有一个大小档处于选中态', !!curScale,
        segs.map(b => (b.classList.contains('on') ? '[' + b.textContent + ']' : b.textContent)).join(' / '));

  await click(segs.find(b => b.textContent === '大'));
  check('点「大」之后提示变成 110%', txt('scale-hint').indexOf('110') >= 0, txt('scale-hint'));
  if (curScale) {
    await click(curScale);
    check('点回原来那一档（不改用户的尺寸）', curScale.classList.contains('on'), txt('scale-hint'));
  }

  const skins = Array.from(document.querySelectorAll('#skins .chip-pick'));
  check('形象有 ' + skins.length + ' 个可选', skins.length >= 1, skins.map(b => b.textContent).join(' / '));
  check('恰好一个形象处于选中态', skins.filter(b => b.classList.contains('on')).length === 1,
        skins.filter(b => b.classList.contains('on')).map(b => b.textContent).join(','));

  // ---- 信息条字段（切到「桌宠上显示」页） ----
  check('能切到「桌宠上显示」页', await go('fields'), curPage());
  const LABEL = '手动记账';

  // 先把「手动记账」归位成已安装。上一轮验收万一没跑完（断言中途失败、进程被杀），
  // 它会停在被卸载的状态 —— 后面每一条「这个字段在不在」的断言都会跟着莫名失败，
  // 而看起来像新改的代码坏了。先归位，这一段才是可重复跑的。
  const mcard0 = card(LABEL);
  if (mcard0) {
    const reinstall = Array.from(mcard0.querySelectorAll('.acts button')).find(b => b.textContent === '安装');
    if (reinstall) await click(reinstall);
  }

  // 字段同理：上一轮可能把它留在信息条上了，先摘掉
  const stale = rowOf(LABEL);
  if (stale) {
    const x0 = stale.querySelectorAll('.ops button')[2];
    if (x0) await click(x0);
  }

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

  // ---- 面板里不该再有「米粒」那一栏 ----
  // 平台已不再折算任何量纲：一笔账按它自己的单位（积分 / 元 / token）飘在鱼身上，
  // 没有「单价」可填。原先是 #prices 一栏 + 一堆 input.num，连同 CSS 一起删了，
  // 这里就地钉住，免得哪天有人照着旧截图又把它加回来。
  check('面板里没有米粒单价栏', !document.getElementById('prices'));
  check('面板里没有吃饱线输入框', !document.getElementById('satiety'));

  // 抓这张图时让字段列表在视野里
  const first = document.querySelector('#field-on .field-row');
  if (first) { first.scrollIntoView({ block: 'start' }); await sleep(400); }
  return out;
})()`

/** b 段：摘掉字段 + 卸载/安装 + 重载 + 关于。 */
const PHASE_B = `(async () => {${HELPERS}
  const LABEL = '手动记账';

  // 先切到插件页：断言读 DOM 不受隐藏影响，但紧接着抓的那张面板图拍的就是当前页，
  // 停在别的页上会拍出一张「和报告里写的不是一回事」的图。
  check('能切到「数据源插件」页', await go('plugins'), curPage());

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
  check('能切到「关于」页', await go('about'), curPage());
  check('关于里显示版本号', /^v\\d+\\.\\d+/.test(txt('version')), txt('version'));
  const src = Array.from(document.querySelectorAll('#about-sources .source'));
  check('关于里列出了每个数据源（' + src.length + ' 个）', src.length === document.querySelectorAll('#providers .plugin').length,
        src.map(s => s.textContent.replace(/\\s+/g, ' ')).join(' | ').slice(0, 120));
  check('关于里写明了当前形象', txt('cur-skin').indexOf('当前形象') >= 0, txt('cur-skin'));

  out.push({ step: '最终字段', ok: true, detail: names().join(' / ') });

  // 切回插件页、滚到用户插件那张卡片上，这样紧接着抓的那张图里能看到它的操作按钮
  check('能切回「数据源插件」页', await go('plugins'), curPage());
  const c3 = card(LABEL);
  if (c3) { c3.scrollIntoView({ block: 'center' }); await sleep(500); }
  return out;
})()`

/** c 段：动作页（按时机分组）—— 去掉 / 加回 / 排序 / 试演。
 *  最后一下才点「试演」，好让紧接着抓的那张桌宠图抓到动作本身。 */
const PHASE_C = `(async () => {${HELPERS}
  const trigs = () => Array.from(document.querySelectorAll('#actions .trig'));
  const trigName = t => { const b = t.querySelector('.trig-name'); return b ? b.textContent : ''; };
  const trigOf = n => trigs().find(t => trigName(t) === n);
  const chipNames = t => Array.from(t.querySelectorAll('.act-chip .nm')).map(x => x.textContent);
  const chipOf = (t, n) => Array.from(t.querySelectorAll('.act-chip')).find(c => {
    const b = c.querySelector('.nm'); return b && b.textContent === n;
  });
  const addSel = t => t.querySelector('select.act-add');
  const spare = () => { const p = document.querySelector('.trig-unused .nm'); return p ? p.textContent : ''; };
  const ranks = t => Array.from(t.querySelectorAll('.act-chip .rank')).map(x => x.textContent).join(',');
  async function pick(sel, value) {
    sel.value = value;
    sel.dispatchEvent(new Event('change'));
    await sleep(500);
  }

  // 动作页在「动作」页上
  check('能切到「动作」页', await go('actions'), curPage());

  const list = trigs();
  check('动作页按时机分成 ' + list.length + ' 张卡片', list.length === 5, list.map(trigName).join(' / '));
  check('五张卡片的顺序是 待机随机 / 偶尔眨眼 / 单击摸摸 / 双击 / 扣费反应',
    list.map(trigName).join(',') === '待机随机,偶尔眨眼,单击摸摸,双击,扣费反应', list.map(trigName).join(','));
  check('每张卡片都有一句说明（用户判断「放这里会怎样」的唯一线索）',
    list.every(t => !!t.querySelector('.trig-desc')));

  // ---- 默认名单 ----
  check('待机随机里是 歪头放电 / 双手叉腰 / 打起精神',
    chipNames(trigOf('待机随机')).join(',') === '歪头放电,双手叉腰,打起精神',
    chipNames(trigOf('待机随机')).join(','));
  check('偶尔眨眼里是 眨眼', chipNames(trigOf('偶尔眨眼')).join(',') === '眨眼',
    chipNames(trigOf('偶尔眨眼')).join(','));
  check('双击里是 开心（双击）', chipNames(trigOf('双击')).join(',') === '开心（双击）',
    chipNames(trigOf('双击')).join(','));
  check('单击摸摸默认借了扣费反应最轻的两档',
    chipNames(trigOf('单击摸摸')).join(',') === '轻痛,普通痛',
    chipNames(trigOf('单击摸摸')).join(','));

  // ---- 扣费反应是有序的：带序号、能上下挪；别的时机不该露排序按钮 ----
  check('扣费反应里有三档', chipNames(trigOf('扣费反应')).join(',') === '轻痛,普通痛,暴击',
    chipNames(trigOf('扣费反应')).join(','));
  check('每一档都带序号（顺序 = 轻重）', ranks(trigOf('扣费反应')) === '1,2,3', ranks(trigOf('扣费反应')));
  check('只有扣费反应露出排序按钮',
    trigs().filter(t => t.querySelector('.act-chip .mv')).length === 1,
    trigs().filter(t => t.querySelector('.act-chip .mv')).map(trigName).join(',') || '无');
  check('第一档的 ↑ 和最后一档的 ↓ 是禁用的',
    !!chipOf(trigOf('扣费反应'), '轻痛').querySelector('.mv[disabled]')
    && !!chipOf(trigOf('扣费反应'), '暴击').querySelector('.mv[disabled]'));

  check('计数形如 n/m', /^\\d+\\/\\d+$/.test(txt('action-count')), txt('action-count'));
  check('默认全在用（8/8）', txt('action-count') === '8/8', txt('action-count'));
  check('没有「没安排时机」的动作', spare() === '（没有）', spare());

  // ---- 去掉一个动作：它要掉进「没安排时机」、计数减一、那一组要说清楚自己空了 ----
  //
  // 这一步刻意挑**只有一个动作**的「偶尔眨眼」：加回一个动作是**追加到末尾**，
  // 单元素名单的「末尾」就是原位，所以来回一趟能回到一模一样的状态。
  // 多元素的池子回不去原顺序（无序的池子界面上没有排序按钮）—— 验收会改用户配置，
  // 所以每一步都得想清楚怎么收干净，这也是下面那条「回到默认」硬断言存在的理由。
  const blinkChip = chipOf(trigOf('偶尔眨眼'), '眨眼');
  check('胶囊上有「×」', !!blinkChip.querySelector('.x'));
  await click(blinkChip.querySelector('.x'));
  check('眨眼拿掉之后那一组空了', chipNames(trigOf('偶尔眨眼')).length === 0,
    JSON.stringify(chipNames(trigOf('偶尔眨眼'))));
  check('空组有说明文字（不是一片空白）', !!trigOf('偶尔眨眼').querySelector('.trig-empty'));
  check('被拿掉的动作出现在「没安排时机」里', spare() === '眨眼', spare());
  check('计数减到 7/8', txt('action-count') === '7/8', txt('action-count'));
  check('「加动作」的下拉里能再选到它',
    Array.from(addSel(trigOf('偶尔眨眼')).options).some(o => o.textContent === '眨眼'));

  await pick(addSel(trigOf('偶尔眨眼')), 'blink');
  check('再加回来，恢复原样', chipNames(trigOf('偶尔眨眼')).join(',') === '眨眼',
    chipNames(trigOf('偶尔眨眼')).join(','));
  check('计数回到 8/8', txt('action-count') === '8/8', txt('action-count'));
  check('「没安排时机」又空了', spare() === '（没有）', spare());

  // ---- 排序：把「暴击」往上挪一位，再挪回去 ----
  const mvOf = (t, n, arrow) => Array.from(chipOf(t, n).querySelectorAll('.mv'))
    .find(b => b.textContent === arrow);
  await click(mvOf(trigOf('扣费反应'), '暴击', '↑'));
  check('暴击上移一位后排到 2 号位', chipNames(trigOf('扣费反应')).join(',') === '轻痛,暴击,普通痛',
    chipNames(trigOf('扣费反应')).join(','));
  check('序号跟着重排', ranks(trigOf('扣费反应')) === '1,2,3', ranks(trigOf('扣费反应')));
  await click(mvOf(trigOf('扣费反应'), '暴击', '↓'));
  check('再挪回来，恢复原顺序', chipNames(trigOf('扣费反应')).join(',') === '轻痛,普通痛,暴击',
    chipNames(trigOf('扣费反应')).join(','));

  // ---- 收尾自检：折腾了一整轮，是不是真的回到原样了 ----
  // 这不是「顺手多验一条」：验收会真的改用户配置，收不干净用户下次打开面板会发现
  // 自己的搭配被改过。所以「回到默认」是硬断言，不是注释里的一句承诺。
  const DEFAULT_LISTS = {
    '待机随机': '歪头放电,双手叉腰,打起精神',
    '偶尔眨眼': '眨眼',
    '单击摸摸': '轻痛,普通痛',
    '双击': '开心（双击）',
    '扣费反应': '轻痛,普通痛,暴击',
  };
  const off = Object.keys(DEFAULT_LISTS).filter(k => chipNames(trigOf(k)).join(',') !== DEFAULT_LISTS[k]);
  check('跑完回到原样：五个时机的名单都跟默认一致', off.length === 0,
    off.map(k => k + '=' + chipNames(trigOf(k)).join('+')).join(' | ') || '五个都对');

  out.push({ step: '跑完的名单', ok: true,
    detail: trigs().map(t => trigName(t) + '=' + chipNames(t).join('+')).join(' | ') });

  // 滚到动作列表上：紧接着抓的那张面板图里才看得到它
  const box = document.getElementById('actions');
  if (box) { box.scrollIntoView({ block: 'center' }); await sleep(400); }

  // ---- 试演放最后：主进程点完就抓桌宠，抓到的才是动作本身 ----
  const nm = chipOf(trigOf('待机随机'), '双手叉腰').querySelector('.nm');
  check('胶囊上的名字是可点的按钮（点一下 = 试演）', !!nm);
  if (nm) {
    nm.click();
    await sleep(120);
    check('试演后弹了提示', document.getElementById('toast').classList.contains('show'), txt('toast'));
  }
  return out;
})()`

// 曾经还有一段 d：面板里的「米粒」栏（每个来源一行单价）。那一栏已经删了 ——
// 平台不再折算任何量纲，一笔账就按它自己的单位飘在鱼身上，所以没有可填的单价。
// 之所以不留一个「确认它不在了」的 d 段：那种断言的寿命只有一个提交，
// 而留着的骨架会让人以为这一栏还在，不值得。

module.exports = { PHASE_A, PHASE_B, PHASE_C }
