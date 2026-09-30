# -*- coding: utf-8 -*-
"""把白底贴纸原图抠成透明素材（桌宠帧的输入）。

一次处理四张源图，产出四个 `_sticker*.png`：

  _source.png        → _sticker.png        眯眼剪刀手（原形象，保留作"调皮"表情）
  _source-open.png   → _sticker-open.png   双眼睁开（待机主体）
  _source-shut.png   → _sticker-shut.png   双眼闭合（眨眼用）
  _source-hips.png   → _sticker-hips.png   双手叉腰（空闲小动作）

后三张是 AI 按同一角色重绘的，构图和第一张几乎逐像素对齐（缩到同尺寸后
差异 >40 的像素只占 1.2~1.8%），所以**文字掩膜、人物下沿曲线这些标定值
按高度比例缩放后可以直接复用** —— 不用每张重标一遍。

标定基准是 960×960；其它尺寸按 s = h/960 自动缩放（见 scale_params()）。

## 三步管线（顺序不能换）

**① 删文字**（文字压裙摆上）：判据用文字自己的填充色（R 低 / B 高 / B-G 拉开），
按分量外接框的顶边取每列掩膜起点，被挡住的荷叶边**沿顶边镜像反射**补回来
（不用 inpaint —— Telea 跨宽条带只会拉出一片灰白渐变，花纹全糊）。
叉腰那张图没有文字，跳过这一步。

**② 去白边**（原画自带的白描边，缩到桌宠尺寸就是一圈扎眼的白光晕）：
三条判据同时成立才算白边 —— ① 非墨线（亮度够高）② 从画面四边洪泛能到
③ 离已透明像素不超过 BAND_MAX。缺①会啃掉围裙，缺③会削掉白色头饰。

**③ 清孤立碎片**：只留最大连通分量（实测占 99.9%）。

最后颜色外扩 + alpha 柔化 + 裁到内容外接框。

## 背景判据改过（这版的关键修订）

上一版写死 `|rgb - 253| <= 2`。原图背景恰好是 #FDFDFD 所以能用，但 AI 重绘的
三张背景在 247~253 之间浮动（还带轻微渐变），`_source-shut.png` 直接用旧判据
会算出 **98.9% 前景** —— 整张图都被当成人物，抠图等于没做。

改成「三个通道都够亮 + 饱和度够低」：背景和白色衣物都满足，但**白色衣物在
角色轮廓之内、被墨线挡着，从四边洪泛进不去**，所以不会误伤。
"""
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

sys.stdout.reconfigure(encoding="utf-8")

ASSET = r"D:\WhalePet\assets\shayu"
TOOLS = r"D:\WhalePet\tools"

# ---- 标定基准：_source.png 是 960×960，下面这些值都是在它上面量出来的 ----
REF_H = 960
REF = dict(
    x_l=108, x_r=662,       # 文字横向范围。662 之后是尾巴，不能碰
    y2=790,                 # 第二行文字及以上：790 以下没有任何人物像素（尾巴最低 755）
    glyph_y_min=692,        # 笔画分量顶边必须不高于此值才算文字（滤掉人物上的误检）
    outline=13,             # 文字描边厚度：掩膜起点 = 笔画填充顶边 - OUTLINE
    seam_px=7,              # 反射块上下接缝各羽化的像素数
    band_max=14,            # 白边最大纵深（白边只有几像素厚）
)
REF_DECO = (220, 600, 238)  # 左上角星星/动感线的清除区 y0, y1, x1
# hem(x)：人物真实下沿，手工标定（读数来自 tools/_probe-hem.png 那张 2 倍放大图）
REF_HEM = [
    (108, 700), (160, 700), (200, 700),
    (215, 693), (245, 692), (275, 698),
    (310, 702), (360, 703), (420, 703), (470, 705),
    (520, 707), (560, 712), (600, 722), (635, 730), (662, 736),
]

BG_MIN_CH = 230     # 「够亮」的下限（三通道都要过）
BG_MAX_SAT = 20     # 「够灰」的上限（max-min）
INK_LUM = 130       # 低于这个亮度算墨线（挡墙，洪泛过不去）
FEATHER_SIGMA = 0.7

# 每张源图 → 输出 → 要不要删文字
JOBS = [
    ("_source.png", "_sticker.png", True),
    ("_source-open.png", "_sticker-open.png", True),
    ("_source-shut.png", "_sticker-shut.png", True),
    ("_source-hips.png", "_sticker-hips.png", False),
]


def disk(r):
    y, x = np.ogrid[-r:r + 1, -r:r + 1]
    return (x * x + y * y) <= r * r


def scale_params(h):
    """把 REF 那套标定值按图片高度等比缩放。"""
    s = h / REF_H
    p = {k: round(v * s) for k, v in REF.items()}
    p["deco"] = tuple(round(v * s) for v in REF_DECO)
    p["hem"] = [(round(x * s), round(y * s)) for x, y in REF_HEM]
    p["s"] = s
    return p


def foreground(rgb):
    """从画面四边洪泛「近白且低饱和」的像素 = 背景，其余是人物。

    白色衣物也是「近白低饱和」，但它在角色轮廓以内、被墨线挡着，洪泛到不了，
    所以不会误伤 —— 这与「按颜色直接判背景」有本质区别。
    """
    a = rgb.astype(np.int16)
    mx, mn = a.max(axis=2), a.min(axis=2)
    near = (mn >= BG_MIN_CH) & ((mx - mn) <= BG_MAX_SAT)
    lab, _ = ndimage.label(near, np.ones((3, 3), int))
    border = set(lab[0, :].tolist()) | set(lab[-1, :].tolist())
    border |= set(lab[:, 0].tolist()) | set(lab[:, -1].tolist())
    border.discard(0)
    fg = ~np.isin(lab, list(border))
    fg = ndimage.binary_closing(fg, disk(2), iterations=1)
    fg = ndimage.binary_opening(fg, disk(1), iterations=1)
    return fg


def strip_text(src, fg, p):
    """删掉压在裙摆上的两行文字，返回 (rgb, alpha, 掩膜, 重建区, 杂块, 笔画数)。"""
    h, w, _ = src.shape
    R, G, B = src[:, :, 0], src[:, :, 1], src[:, :, 2]
    # 文字填充是 #182888 / #485898 / #283888 这一族：R 很低、B 很高、B-G 拉开。
    # 人物身上的蓝（头发 #78A8D8、裙子 #383868）都不满足。
    glyph_fill = (B - G >= 40) & (B >= 128) & (R <= 90)

    band = np.zeros((h, w), bool)
    band[p["glyph_y_min"]:p["y2"], :] = True
    gl, gn = ndimage.label(glyph_fill & band, np.ones((3, 3), int))

    # 逐列的「最上笔画像素」不能用：`l` 的衬线让右边缘那几列读到很靠下，
    # 掩膜就会从那儿才开始、字母上半截整条留下（白色细柱鬼影）。
    # 改用**分量外接框的顶边**：一个笔画在它整个横向范围内，顶边就是 bbox 的 y0。
    col_top = np.full(w, 1e9)
    n_keep = 0
    for i in range(1, gn + 1):
        m = gl == i
        if m.sum() < 60:
            continue
        ys, xs = np.nonzero(m)
        if ys.min() < p["glyph_y_min"] or xs.min() < p["x_l"] or xs.max() > p["x_r"]:
            continue
        n_keep += 1
        x0, x1 = int(xs.min()), int(xs.max())
        col_top[x0:x1 + 1] = np.minimum(col_top[x0:x1 + 1], float(ys.min()))

    if n_keep < 4:
        raise SystemExit("  笔画分量只有 %d 个，颜色判据失效，需要重新标定" % n_keep)
    known = np.nonzero(col_top < 1e9)[0]
    xs_all = np.arange(w)
    glyph_top = np.interp(xs_all, known, col_top[known])   # 缺口列线性插值
    top_c = glyph_top - p["outline"]

    hem_c = np.interp(xs_all, [q[0] for q in p["hem"]], [q[1] for q in p["hem"]])
    yy = np.arange(h)[:, None]
    mask = (yy >= top_c[None, :]) & (xs_all[None, :] >= p["x_l"]) & (xs_all[None, :] <= p["x_r"])
    mask[p["y2"]:, :] = True

    # 左上角的星星和动感线：只保留与身体连通的最大分量，区域内其余前景一律抹掉。
    # 比按面积阈值筛可靠 —— 抗锯齿会把装饰拆成大小不一的小块，面积过滤总有漏网的。
    y0, y1, x1 = p["deco"]
    lab_fg, n = ndimage.label(fg, np.ones((3, 3), int))
    areas = ndimage.sum(fg, lab_fg, range(1, n + 1))
    body_label = int(np.argmax(areas)) + 1
    deco_zone = np.zeros((h, w), bool)
    deco_zone[y0:y1, 0:x1] = True
    stray = deco_zone & fg & (lab_fg != body_label)
    mask |= stray

    # 沿 top(x) 镜像反射补回被文字挡住的荷叶边
    rgb = src.copy()
    alpha = fg.astype(np.float32).copy()
    recon = np.zeros((h, w), bool)
    for x in range(p["x_l"], p["x_r"] + 1):
        ptop = int(round(top_c[x]))
        e = int(round(min(hem_c[x], p["y2"] - 1)))
        if e <= ptop:
            continue
        rows = np.arange(ptop, e + 1)
        sy = 2 * ptop - 1 - rows
        ok = (sy >= 0) & (sy <= ptop - 1)
        if not ok.any():
            continue
        rows, sy = rows[ok], sy[ok]
        rgb[rows, x] = src[sy, x]
        alpha[rows, x] = fg[sy, x].astype(np.float32)
        recon[rows, x] = True
        # 接缝羽化：反射块上下沿各压几像素，避免出现一条硬镜像线
        k = int(min(p["seam_px"], max(1, (e - ptop) // 3)))
        alpha[ptop:ptop + k, x] *= np.linspace(0.5, 1.0, k)
        t = min(k, max(0, e - ptop - k))
        if t > 0:
            alpha[e - t + 1:e + 1, x] *= np.linspace(1.0, 0.5, t)

    target = np.where(recon, alpha, np.where(mask, 0.0, alpha))
    return rgb, target, mask, recon, stray, n_keep


def strip_fringe(rgb, alpha, band_max):
    """去白边：三条判据同时成立才算白边（见文件头）。"""
    lum = 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]
    hollow = alpha <= 0.03
    free = (lum >= INK_LUM) | hollow
    lab, _ = ndimage.label(free, np.ones((3, 3), int))
    rim = {*lab[0].tolist(), *lab[-1].tolist(), *lab[:, 0].tolist(), *lab[:, -1].tolist()}
    rim.discard(0)
    flood = np.isin(lab, list(rim))
    near = ndimage.distance_transform_edt(~hollow) <= band_max
    return flood & ~hollow & near


def drop_junk(alpha):
    lab, n = ndimage.label(alpha > 0.5, np.ones((3, 3), int))
    if n <= 1:
        return np.zeros_like(alpha, bool)
    keep = int(np.argmax(ndimage.sum(alpha > 0.5, lab, range(1, n + 1)))) + 1
    return (alpha > 0.5) & (lab != keep)


def finish(rgb, alpha, fixed_box=None):
    """颜色外扩（吃掉半透明边缘的黑边）+ alpha 柔化 + 裁切。

    fixed_box 给定就按它裁（源图坐标系），否则按内容外接框裁。

    **为什么必须支持固定框**：三张同构图的源图如果各自按内容裁，裁出来的框
    会被各自最靠下的那个元素（左发梢 / 尾巴尖）带偏，同一角色在三张贴纸里的
    相对位置和大小就不一致 —— 帧生成器再按高度归一化，三套帧之间就会整体错位，
    「闭眼帧」看起来像整体跳了一下。所以这三张统一按第一张的内容框裁。
    """
    solid = alpha > 0.5
    inner = ndimage.binary_erosion(solid, disk(2), iterations=1)
    if not inner.any():
        inner = solid
    _, (iy, ix) = ndimage.distance_transform_edt(~inner, return_indices=True)
    rgb_final = rgb[iy, ix]
    alpha_final = (ndimage.gaussian_filter(alpha, FEATHER_SIGMA) * 255).clip(0, 255).astype(np.uint8)
    out = Image.fromarray(np.dstack([rgb_final, alpha_final]).astype(np.uint8), "RGBA")

    if fixed_box is not None:
        x0, y0, x1, y1 = fixed_box
        box = (max(0, x0), max(0, y0), min(out.width, x1), min(out.height, y1))
        # 固定框如果切到了内容，报出来（对齐优先，但至少要看得见代价）
        a = np.asarray(out)[:, :, 3]
        cut = int((a[:box[1], :] > 8).sum() + (a[box[3]:, :] > 8).sum()
                  + (a[:, :box[0]] > 8).sum() + (a[:, box[2]:] > 8).sum())
        if cut:
            print("      固定框外仍有内容 %d px（对齐优先，这部分会被裁掉）" % cut)
        return out.crop(box), box

    a = np.asarray(out)[:, :, 3]
    ys, xs = np.nonzero(a > 8)
    box = (int(xs.min()) - 2, int(ys.min()) - 2, int(xs.max()) + 3, int(ys.max()) + 3)
    return out.crop(box), box


def tag_of(out_name):
    """_sticker.png → base，_sticker-open.png → open，_sticker-hips.png → hips"""
    stem = out_name[:-4] if out_name.endswith(".png") else out_name
    return stem[len("_sticker"):].lstrip("-_") or "base"


def process(src_name, out_name, with_text, fixed_box=None):
    src_pil = Image.open(os.path.join(ASSET, src_name)).convert("RGB")
    src = np.asarray(src_pil).astype(np.float32)
    h, w, _ = src.shape
    p = scale_params(h)
    print("  %-18s %dx%d  缩放 %.3f" % (src_name, w, h, p["s"]))

    fg = foreground(src)
    print("      前景 %.1f%%" % (fg.mean() * 100))

    mask = recon = stray = np.zeros((h, w), bool)
    if with_text:
        rgb, alpha, mask, recon, stray, n_keep = strip_text(src, fg, p)
        print("      笔画分量 %d · 镜像重建 %d px · 装饰清除 %d px" % (n_keep, recon.sum(), stray.sum()))
    else:
        rgb, alpha = src.copy(), fg.astype(np.float32)

    fringe = strip_fringe(rgb, alpha, p["band_max"])
    alpha = np.where(fringe, 0.0, alpha)
    solid_px = max(1, int((alpha > 0.03).sum()))
    print("      去白边 %d px（占实心 %.2f%%）" % (fringe.sum(), fringe.sum() / solid_px * 100))

    junk = drop_junk(alpha)
    alpha = np.where(junk, 0.0, alpha)
    if junk.any():
        print("      清孤立碎片 %d px" % junk.sum())

    out, box = finish(rgb, alpha, fixed_box)
    out.save(os.path.join(ASSET, out_name))
    print("      → %s  %s" % (out_name, out.size))

    # 质检一：掩膜标记（品红=删字 / 绿=镜像重建 / 蓝=去白边 / 橙=孤立碎片）
    pa = np.asarray(src_pil).copy()
    for m, color in ((mask, (255, 0, 255)), (recon, (0, 255, 120)),
                     (fringe, (0, 190, 255)), (junk, (255, 150, 0))):
        if m.any():
            pa[m] = (pa[m] * 0.35 + np.array(color) * 0.65).astype(np.uint8)
    Image.fromarray(pa).resize((int(w * 0.5), int(h * 0.5)), Image.LANCZOS).save(
        os.path.join(TOOLS, "_qa-mask-%s.png" % tag_of(out_name)))

    # 质检二：深底 + 棋盘双联（白晕只有压在深底上才看得见）
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
    tile.convert("RGB").resize((int(tile.width * 0.55), int(tile.height * 0.55)), Image.LANCZOS).save(
        os.path.join(TOOLS, "_qa-clean-%s.png" % tag_of(out_name)))
    return out, box


if __name__ == "__main__":
    print("=== 抠图（白底贴纸 → 透明素材）===")
    # 第一张（_source.png，960）定基准裁切框；其余同构图的按高度比例换算同一个框，
    # 保证同一角色在三张贴纸里的位置与大小完全一致（见 finish() 的说明）。
    # 叉腰那张构图不同（全身站姿），自己按内容裁。
    base_box = None
    base_h = None
    for src_name, out_name, with_text in JOBS:
        h = Image.open(os.path.join(ASSET, src_name)).height
        if out_name == "_sticker-hips.png":
            process(src_name, out_name, with_text, None)
            continue
        if base_box is None:
            _, base_box = process(src_name, out_name, with_text, None)
            base_h = h
            continue
        s = h / base_h
        process(src_name, out_name, with_text, tuple(round(v * s) for v in base_box))
    print()
    print("质检图 tools/_qa-clean-*.png（深底+棋盘）、tools/_qa-mask-*.png（判据标记）")
