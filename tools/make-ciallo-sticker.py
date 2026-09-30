# -*- coding: utf-8 -*-
"""从新形象里去掉 Ciallo～(∠・ω< )⌒★ 文字和装饰，只留人物。

## 踩过的两个坑（都写在注释里，免得以后又走一遍）

**坑一：按「前景分段缝隙」找文字顶边 —— 不成立。**
探针 `tools/_probe_cols.py` 显示，x>=275 之后每一列在 y 560..799 都是**一整段**
（`[(560, 799)]`）。第一行文字是直接压在裙摆下沿上的，字与裙之间没有背景缝隙，
而且「ll」的升部还往上插进围裙。按段切出来的顶边中位数会掉到 735（真实字顶
约 690），掩膜偏下 → 字母下半截留在图里 → 就是白色字母鬼影的来源。

**坑二：靠「近黑描边」找笔画 —— 也不行。**
人物自身的黑描边在 y>=600 里到处都是，`tools/_probe_glyph.py` 逐列几乎全命中。

**最终办法：拿文字自己的「填充色」当判据。**
文字填充是 #182888 / #485898 / #283888 这一族，特征是 **R 很低、B 很高、
B-G 拉开**；人物身上的蓝（头发 #78A8D8、裙子 #383868）都不满足这条：

    (B - G >= 40) & (B >= 128) & (R <= 90)

再限制到 y>=640 做连通分量，`C / i / a / l / l / o / ～` 六个分量干干净净
（见 `tools/_probe-fill2.png`）。人物身上的误检（比如尾巴 x 781..810 y 640..690）
用「分量顶边必须 >= 692」滤掉——所有笔画分量都满足，误检不满足。

拿到逐列笔画顶边后，掩膜起点 = 笔画顶边 - 13（描边厚度），中间缺列用插值补齐。

## 被文字盖住的那一条怎么补

文字和人物在几何上是**上下关系**，不是穿插关系，所以只要守住两条曲线：

  top(x) —— 掩膜从这里开始（由上面的颜色判据逐列算出，是「尖」的）
  hem(x) —— 人物真实下沿的估计（手工标定的平滑曲线，读数来自
            `tools/_probe-hem.png` 那张 2 倍放大图）

top(x)..hem(x) 这一薄条用**沿 top(x) 上下镜像反射**补回来，而不是 cv2.inpaint：
  * 围裙那圈荷叶边是周期性的弧线，反射能原样复制它的形状；Telea 在大面积上
    只会拉出一片灰白渐变，荷叶边直接糊掉。
  * 反射有个好性质——**往上多切一点几乎无损**，多切的部分会被镜像补回来，
    所以 top(x) 宁可取保守（往上）。

hem(x) 以下一律透明；第二行文字（y>=790）直接整条抹掉。

产出 assets/ciallo/_sticker.png 与 tools/_qa-mask.png / _qa-clean.png / _qa-hem.png
"""
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

sys.stdout.reconfigure(encoding="utf-8")

ASSET = r"D:\WhalePet\assets\ciallo"
SRC = os.path.join(ASSET, "_source.png")
OUT = os.path.join(ASSET, "_sticker.png")
TOOLS = r"D:\WhalePet\tools"

BG = np.array([253, 253, 253], dtype=np.int16)
BG_TOL = 2
CLOSE_PX = 2
OPEN_PX = 1
FEATHER_SIGMA = 0.7

X_L, X_R = 108, 662      # 文字横向范围。662 之后是尾巴，不能碰
Y2 = 790                 # 第二行文字及以上：790 以下没有任何人物像素（尾巴最低 755）
GLYPH_Y_MIN = 692        # 笔画分量顶边必须不高于此值才算文字（用来滤掉人物上的误检）
OUTLINE = 13             # 文字描边厚度：掩膜起点 = 笔画填充顶边 - OUTLINE
SEAM_PX = 7              # 反射块上下接缝各羽化的像素数

# hem(x)：人物真实下沿。手工标定，来自 tools/_probe-hem.png（2 倍放大图）上的读数。
PROF_HEM = [
    (108, 700), (160, 700), (200, 700),
    (215, 693), (245, 692), (275, 698),
    (310, 702), (360, 703), (420, 703), (470, 705),
    (520, 707), (560, 712), (600, 722), (635, 730), (662, 736),
]


def disk(r):
    y, x = np.ogrid[-r:r + 1, -r:r + 1]
    return (x * x + y * y) <= r * r


def foreground_flood(rgb):
    """边界连通的近背景 = 背景，其余是人物。

    纯白 #FFFFFF 刻意排除在外（与 #FDFDFD 差 2，BG_TOL=2 时 |255-253|=2 恰好
    落在容差内，但人物身上有大量纯白高光/围裙，排掉它们会啃出洞）。
    """
    diff = np.abs(rgb.astype(np.int16) - BG).max(axis=2)
    near = diff <= BG_TOL
    lab, _ = ndimage.label(near, np.ones((3, 3), int))
    border = set(lab[0, :].tolist()) | set(lab[-1, :].tolist())
    border |= set(lab[:, 0].tolist()) | set(lab[:, -1].tolist())
    border.discard(0)
    fg = ~np.isin(lab, list(border))
    fg = ndimage.binary_closing(fg, disk(CLOSE_PX), iterations=1)
    fg = ndimage.binary_opening(fg, disk(OPEN_PX), iterations=1)
    return fg


src_pil = Image.open(SRC).convert("RGB")
src = np.asarray(src_pil).astype(np.float32)
h, w, _ = src.shape
fg = foreground_flood(src)
print("前景 %.1f%%" % (fg.mean() * 100))

# ---------- 一、逐列求笔画顶边（颜色判据） ----------
R, G, B = src[:, :, 0], src[:, :, 1], src[:, :, 2]
glyph_fill = (B - G >= 40) & (B >= 128) & (R <= 90)

band = np.zeros((h, w), bool)
band[640:Y2, :] = True
gl, gn = ndimage.label(glyph_fill & band, np.ones((3, 3), int))

# 逐列的「最上笔画像素」不能用 —— 实测 `l` 的衬线让右边缘那几列读到 y=784，
# 掩膜就从 771 才开始，字母上半截整条留在图里（`tools/_probe_col354.py` 抓到的
# 那两条 orig x 354-359 / 394-399 的白色细柱）。改用**分量外接框的顶边**：
# 一个笔画在它整个横向范围内，顶边就是 bbox 的 y0。
col_top = np.full(w, 1e9)
kept = np.zeros((h, w), bool)
n_keep = 0
for i in range(1, gn + 1):
    m = gl == i
    if m.sum() < 60:
        continue
    ys, xs = np.nonzero(m)
    if ys.min() < GLYPH_Y_MIN or xs.min() < X_L or xs.max() > X_R:
        continue
    kept |= m
    n_keep += 1
    x0, x1 = int(xs.min()), int(xs.max())
    seg = col_top[x0:x1 + 1]
    col_top[x0:x1 + 1] = np.minimum(seg, float(ys.min()))
print("笔画分量 %d 个（y>=%d 内共 %d 个候选），覆盖 %d px" % (
    n_keep, GLYPH_Y_MIN, gn, kept.sum()))
if n_keep < 4:
    raise SystemExit("笔画分量太少，颜色判据失效，需要重新标定")

# 注意：初始值不能用 np.nan —— np.minimum 会把 NaN 传播出去，整列就永远是 NaN。
known = np.nonzero(col_top < 1e9)[0]
print("可直接读出笔画顶边的列 %d（x %d..%d）" % (len(known), known.min(), known.max()))

xs_all = np.arange(w)
glyph_top = np.interp(xs_all, known, col_top[known])     # 缺口列线性插值
top_c = glyph_top - OUTLINE
print("掩膜起点 top(x) %d..%d（中位 %d）" % (
    top_c[X_L:X_R + 1].min(), top_c[X_L:X_R + 1].max(), int(np.median(top_c[X_L:X_R + 1]))))

# ---------- 二、掩膜 ----------
hem_c = np.interp(xs_all, [p[0] for p in PROF_HEM], [p[1] for p in PROF_HEM])
yy = np.arange(h)[:, None]
mask = (yy >= top_c[None, :]) & (xs_all[None, :] >= X_L) & (xs_all[None, :] <= X_R)
mask[Y2:, :] = True

# 左上角的星星和动感线：只保留与身体连通的最大分量，区域内其余前景一律抹掉。
# 比按面积阈值筛可靠 —— 抗锯齿会把装饰拆成大小不一的小块，面积过滤总有漏网的。
lab_fg, n = ndimage.label(fg, np.ones((3, 3), int))
areas = ndimage.sum(fg, lab_fg, range(1, n + 1))
body_label = int(np.argmax(areas)) + 1
deco_zone = np.zeros((h, w), bool)
deco_zone[220:600, 0:238] = True
stray = deco_zone & fg & (lab_fg != body_label)
mask |= stray
print("  装饰/杂块清除 %d px（x<238、y 220..600）" % stray.sum())

# ---------- 三、沿 top(x) 镜像反射 ----------
rgb = src.copy()
alpha = fg.astype(np.float32).copy()
recon = np.zeros((h, w), bool)
for x in range(X_L, X_R + 1):
    p = int(round(top_c[x]))
    e = int(round(min(hem_c[x], Y2 - 1)))
    if e <= p:
        continue
    rows = np.arange(p, e + 1)
    sy = 2 * p - 1 - rows
    ok = (sy >= 0) & (sy <= p - 1)
    if not ok.any():
        continue
    rows, sy = rows[ok], sy[ok]
    rgb[rows, x] = src[sy, x]
    alpha[rows, x] = fg[sy, x].astype(np.float32)
    recon[rows, x] = True

# 接缝羽化：反射块上下沿各压几像素，避免出现一条硬镜像线。
for x in range(X_L, X_R + 1):
    p = int(round(top_c[x]))
    e = int(round(min(hem_c[x], Y2 - 1)))
    if e <= p:
        continue
    k = int(min(SEAM_PX, max(1, (e - p) // 3)))
    alpha[p:p + k, x] *= np.linspace(0.5, 1.0, k)
    t = min(k, max(0, e - p - k))
    if t > 0:
        alpha[e - t + 1:e + 1, x] *= np.linspace(1.0, 0.5, t)

tgt_alpha = np.where(recon, alpha, np.where(mask, 0.0, alpha))
print("反射重建 %d px" % recon.sum())

if os.environ.get("WHALEPET_DEBUG_COLS"):
    for x in [int(v) for v in os.environ["WHALEPET_DEBUG_COLS"].split(",")]:
        p = int(round(top_c[x]))
        e = int(round(min(hem_c[x], Y2 - 1)))
        print("  x=%3d top=%d hem=%d  mask(760)=%s recon(700)=%s tgt(760)=%.2f  col_top(known)=%s" % (
            x, p, e, mask[760, x], recon[min(700, e), x], tgt_alpha[760, x],
            ("%.0f" % col_top[x]) if x in set(known.tolist()) else "插值"))

# ---------- 三·五、去白边（原画自带的白描边） ----------
# 原图是一张「白底贴纸」：轮廓外本来就画了一圈白边，抠图时这圈白整片留下来，
# 缩到桌宠尺寸就是一圈扎眼的白光晕。判据要三条同时成立，缺一条都会误伤：
#   ① 亮度 >= INK_LUM 才算「非墨线」—— 墨线挡路，洪泛才进不去角色内部；
#   ② 从画面四边沿「非墨线」像素洪泛 —— 拿到的是「背景 + 贴在轮廓外的白边」；
#   ③ 离已透明像素不超过 BAND_MAX —— 白边只有几像素厚，而洪泛绕过轮廓后能摸到的
#      **白色衣物**（女仆围裙）离背景很远，用它把围裙挡在外面。
#
# 只用 ①② 会把围裙整片吃掉（实测 42k px vs 正确的 24k px）；
# 只用 ③ 会把女仆头饰的外沿削掉。三条一起才是干净的一圈。
INK_LUM = 130
BAND_MAX = 14
_lum = 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]
_hollow = tgt_alpha <= 0.03                       # 已经抠干净的背景
_free = (_lum >= INK_LUM) | _hollow               # 可通行 = 非墨线
_lab, _ = ndimage.label(_free, np.ones((3, 3), int))
_rim = {*_lab[0].tolist(), *_lab[-1].tolist(), *_lab[:, 0].tolist(), *_lab[:, -1].tolist()}
_rim.discard(0)
_flood = np.isin(_lab, list(_rim))
_near = ndimage.distance_transform_edt(~_hollow) <= BAND_MAX
fringe = _flood & ~_hollow & _near
tgt_alpha = np.where(fringe, 0.0, tgt_alpha)
_hard = int((~_hollow).sum())
print("去白边 %d px（占实心 %.2f%%）" % (fringe.sum(), fringe.sum() / max(1, _hard) * 100))

# 孤立碎片：去字镜像和白边剥离都可能在正文之外留下几十像素的小岛（实测 5 个，
# 白点/白线各一条）。判据不用想复杂 —— 主分量占 99.9%，按「只留最大分量」处理最稳。
_lab2, _n2 = ndimage.label(tgt_alpha > 0.5, np.ones((3, 3), int))
junk = np.zeros_like(fringe)
if _n2 > 1:
    _keep = int(np.argmax(ndimage.sum(tgt_alpha > 0.5, _lab2, range(1, _n2 + 1)))) + 1
    junk = (tgt_alpha > 0.5) & (_lab2 != _keep)
    tgt_alpha = np.where(junk, 0.0, tgt_alpha)
    print("清孤立碎片 %d px（%d 块）" % (junk.sum(), _n2 - 1))

# ---------- 四、颜色外扩 + alpha 柔化 ----------
solid = tgt_alpha > 0.5
inner = ndimage.binary_erosion(solid, disk(2), iterations=1)
if not inner.any():
    inner = solid
_, (iy, ix) = ndimage.distance_transform_edt(~inner, return_indices=True)
rgb_final = rgb[iy, ix]
alpha_final = (ndimage.gaussian_filter(tgt_alpha, FEATHER_SIGMA) * 255).clip(0, 255).astype(np.uint8)

out = Image.fromarray(np.dstack([rgb_final, alpha_final]).astype(np.uint8), "RGBA")
a = np.asarray(out)[:, :, 3]
ys, xs = np.nonzero(a > 8)
box = (int(xs.min()) - 2, int(ys.min()) - 2, int(xs.max()) + 3, int(ys.max()) + 3)
out = out.crop(box)
out.save(OUT)
print("_sticker.png %s  box %s" % (out.size, box))

# ---------- 五、质检 ----------
pa = np.asarray(src_pil).copy()
pa[mask] = (pa[mask] * 0.45 + np.array([255, 0, 255]) * 0.55).astype(np.uint8)
pa[recon] = (pa[recon] * 0.35 + np.array([0, 255, 120]) * 0.65).astype(np.uint8)
pa[fringe] = (pa[fringe] * 0.25 + np.array([0, 190, 255]) * 0.75).astype(np.uint8)
pa[junk] = (pa[junk] * 0.2 + np.array([255, 150, 0]) * 0.8).astype(np.uint8)
Image.fromarray(pa).resize((int(w * 0.62), int(h * 0.62)), Image.LANCZOS).save(
    os.path.join(TOOLS, "_qa-mask.png"))

cw, ch = out.size
tile = Image.new("RGBA", (cw * 2 + 24, ch), (0, 0, 0, 0))
dark = Image.new("RGBA", (cw, ch), (18, 22, 34, 255))
dark.alpha_composite(out)
tile.alpha_composite(dark, (0, 0))
checker = Image.new("RGBA", (cw, ch), (255, 255, 255, 255))
pxc = checker.load()
for y in range(ch):
    for x in range(cw):
        if ((x // 12) + (y // 12)) % 2:
            pxc[x, y] = (198, 205, 215, 255)
checker.alpha_composite(out)
tile.alpha_composite(checker, (cw + 24, 0))
tile.convert("RGB").resize((int(tile.width * 0.62), int(tile.height * 0.62)), Image.LANCZOS).save(
    os.path.join(TOOLS, "_qa-clean.png"))

zh = min(240, out.height)
z = out.crop((0, out.height - zh, out.width, out.height))
zd = Image.new("RGBA", z.size, (18, 22, 34, 255))
zd.alpha_composite(z)
zd.convert("RGB").resize((int(z.width * 1.3), int(z.height * 1.3)), Image.LANCZOS).save(
    os.path.join(TOOLS, "_qa-hem.png"))
print("质检图 _qa-mask.png（品红=删字 / 绿=反射重建 / 蓝=去白边 / 橙=孤立碎片）/ _qa-clean.png / _qa-hem.png")
