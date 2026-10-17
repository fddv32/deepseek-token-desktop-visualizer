// 尺寸几何：一个 scale 管两件事 —— 窗口多大、形象最后被画成多大。
//
// 为什么单独抽一个文件：这段算错的代价不小，而且错法很隐蔽。
// 形象是**只缩不放**的 —— renderer/pet.css 用 max-height / max-width 做 contain，
// 图片永远长不过自己的原始像素。所以 scale 大到某个倍数之后，形象已经画到 1:1 不再长大，
// 窗口却还在按 scale 长：窗口和信息条越来越宽，鱼悬在原地不动。
//
// 实测（tools/probe-scale.py，大档 140% 那一版）：
//   窗口 532x660，鱼只有 372x369，底边离信息条空出 171px —— 桌面上就是「一个很宽的空框
//   里放着鱼，框底还吊着一条同样很宽的信息条」。用户看到的「大形象太宽」就是这个。
//   对照：小档 70% 时鱼占窗口宽 80%，中档 100% 时 85%，到了 140% 反而掉到 70%（因为
//   鱼根本没变大）。三档里形象的长宽比一直是 1.006~1.009，所以没有任何拉伸，纯粹是
//   「窗口在长、形象没跟上」。
//
// 于是「最大档位」这件事必须有个约束，就是下面的 MAX_SCALE / maxScale()：
//   保证每个能在界面上选到的倍数，形象都还跟着变大（petAreaH <= CANVAS_H）。
// tools/test-scale.js 拿真素材核对着这条不变量，image 尺寸改了、常量忘了改会当场红。
//
// CANVAS_H 480 → 458 → 428 → 462（PET_AREA_H 同步 420 → 412 → 385 → 415）：
//   帧里形象的最低点离画布底只有十几行，而上面每一行透明像素都会一路顶到信息条上方 ——
//   用户说的「形象和文字栏离得太远」主要就是它。458→428 是配合生成脚本把形象上移
//   （OY 33.3→3.3），把「头顶留白」从 16.2% 压到 10.3% —— 半身立绘的惯例是 8~10%。
//   428→462 是**换主体**带来的：所有动作改用「叉腰那张的半身」当模板（它的裙子有完整
//   蕾丝下摆、结构最像样），而它比原来那张**又瘦又高**（692×773 vs 757×743）。
//   生成脚本的 K 同步 0.49 → 0.51，让形象在画布里的占比和原来持平；画布跟着长高，
//   否则底部只剩 6px，动作里 dy=+9 会顶到边。
//   PET_AREA_H 每次都要跟着**升**，是为了把 maxScale 顶回 1.1 以上 —— 不然界面上「大」
//   那一档会被 clampScale 悄悄夹成 1.09，点了「大」却不是 110%。
//   这条联动（改 CANVAS_H 就要回算 PET_AREA_H）test-scale.js 管不到，只能靠记。
//
// 纯几何，不碰 fs / electron，所以 node 能直接 require 来测。
'use strict'

const BASE_W = 380        // scale = 1 时窗口宽（信息条要一行放得下，不能比这更窄）
const PET_AREA_H = 415    // scale = 1 时留给形象的高度；信息条另算
const CANVAS_W = 420      // 帧画布的原始像素（assets/<形象>/frames/*.png）
const CANVAS_H = 462
const GAP = 4             // #pet 的 max-height 里扣掉的那 4px，见 pet.css
const MIN_SCALE = 0.5     // 再小就没法用手把桌宠拖回来了
const MAX_SCALE = 1.1     // 界面上「大」那一档；再大就只剩窗口在长（见文件头）

/** 窗口尺寸。信息条高度是渲染端量完回报的（字段勾多了会换行变高）。 */
function baseSize(scale, barH) {
  return {
    w: Math.round(BASE_W * scale),
    h: Math.round((PET_AREA_H + barH) * scale),
  }
}

/** 形象实际能用的高度 = 窗口高 - 信息条 - 那 4px 让位（对应 pet.css 的 max-height）。 */
function petAreaH(scale, barH) {
  return baseSize(scale, barH).h - barH - GAP
}

/**
 * 形象**还跟着变大**的最大倍数。
 *
 * 再往上，形象画布已经顶到自己的原始高度（petAreaH > CANVAS_H），contain 只把它缩到
 * 原始大小为止 —— 倍数继续加，只有窗口和信息条在长。信息条越高，形象能用的高度被吃掉
 * 的越多，这个上限就越低（信息条 52px 时约 1.11，320px 时约 1.07）。
 */
function maxScale(barH) {
  return (CANVAS_H + barH + GAP) / (PET_AREA_H + barH)
}

/**
 * 把用户给的倍数夹进合法范围。
 *
 * 上限取 min(MAX_SCALE, maxScale(barH))：信息条特别高的时候，「大」也会被拉到
 * 形象还长得动的那个范围内，而不是留一个空框。取整向下（floor）而不是四舍五入 ——
 * 否则 1.086 会被放成 1.09，刚好越过上限。
 */
function clampScale(v, barH) {
  const n = Number(v)
  if (!Number.isFinite(n)) return NaN // 调用方兜底（main.js 用 DEFAULT_SCALE）
  const hi = Math.min(MAX_SCALE, maxScale(barH))
  const r = Math.round(n * 100) / 100
  if (r > hi) return Math.floor(hi * 100) / 100
  return Math.min(hi, Math.max(MIN_SCALE, r))
}

module.exports = {
  BASE_W, PET_AREA_H, CANVAS_W, CANVAS_H, GAP,
  MIN_SCALE, MAX_SCALE,
  baseSize, petAreaH, maxScale, clampScale,
}
