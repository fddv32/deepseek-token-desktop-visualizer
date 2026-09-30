# -*- coding: utf-8 -*-
"""量出各张源图里「人物」和「文字」的几何位置，用来给抠图标定参数定值。

为什么要量而不是照着 _source.png 的常数抄：新生成的图尺寸和构图都变了
（960 → 1024），文字带和人物下沿的像素位置不能直接照搬。

判据沿用 make-shayu-sticker.py 的那两条：
  近背景洪泛 → 人物前景
  文字填充色（R 低、B 高、B-G 拉开）→ 文字笔画
"""
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

sys.stdout.reconfigure(encoding="utf-8")

ASSET = r"D:\WhalePet\assets\shayu"
BG = np.array([253, 253, 253], dtype=np.int16)
BG_TOL = 2


def disk(r):
    y, x = np.ogrid[-r:r + 1, -r:r + 1]
    return (x * x + y * y) <= r * r


def analyze(name):
    p = os.path.join(ASSET, name)
    if not os.path.exists(p):
        print("  (缺 %s)" % name)
        return
    im = Image.open(p).convert("RGB")
    a = np.asarray(im).astype(np.int16)
    h, w, _ = a.shape

    diff = np.abs(a - BG).max(axis=2)
    near = diff <= BG_TOL
    lab, _ = ndimage.label(near, np.ones((3, 3), int))
    border = set(lab[0, :].tolist()) | set(lab[-1, :].tolist())
    border |= set(lab[:, 0].tolist()) | set(lab[:, -1].tolist())
    border.discard(0)
    fg = ~np.isin(lab, list(border))
    fg = ndimage.binary_closing(fg, disk(2), iterations=1)
    fg = ndimage.binary_opening(fg, disk(1), iterations=1)

    # 只留最大连通分量当「人物」（排除星星/动感线）
    labf, nf = ndimage.label(fg, np.ones((3, 3), int))
    areas = ndimage.sum(fg, labf, range(1, nf + 1))
    body = labf == (int(np.argmax(areas)) + 1)
    ys, xs = np.nonzero(body)
    print("  %-20s %dx%d  前景 %.1f%%" % (name, w, h, fg.mean() * 100))
    print("      人物最大分量 bbox: x %d..%d  y %d..%d" % (xs.min(), xs.max(), ys.min(), ys.max()))

    R, G, B = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    glyph = (B - G >= 40) & (B >= 128) & (R <= 90)
    # 文字在下半部分
    band = np.zeros((h, w), bool)
    band[int(h * 0.60):, :] = True
    gl, gn = ndimage.label(glyph & band, np.ones((3, 3), int))
    comps = []
    for i in range(1, gn + 1):
        m = gl == i
        if m.sum() < 60:
            continue
        cy, cx = np.nonzero(m)
        comps.append((int(cy.min()), int(cy.max()), int(cx.min()), int(cx.max()), int(m.sum())))
    if comps:
        ty0 = min(c[0] for c in comps)
        ty1 = max(c[1] for c in comps)
        tx0 = min(c[2] for c in comps)
        tx1 = max(c[3] for c in comps)
        print("      文字分量 %d 个，笔画 bbox: x %d..%d  y %d..%d" % (len(comps), tx0, tx1, ty0, ty1))
        print("      文字各分量顶边: %s" % sorted(c[0] for c in comps))
    else:
        print("      文字分量 0 个（这张图没有文字）")


print("=== assets/shayu 各源图几何 ===")
for nm in ("_source.png", "_source-open.png", "_source-shut.png", "_source-hips.png"):
    analyze(nm)
