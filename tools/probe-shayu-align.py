# -*- coding: utf-8 -*-
"""对齐检查：把新生成的源图缩到与原图同尺寸，逐像素比对，量出构图差异。

用途：判断能不能直接复用 _source.png 已经标定好的那套参数
（文字掩膜、人物下沿曲线）；差得多就得重新标定。
"""
import os
import sys

import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")

ASSET = r"D:\WhalePet\assets\shayu"
TOOLS = r"D:\WhalePet\tools"


def corners(name):
    im = Image.open(os.path.join(ASSET, name)).convert("RGB")
    a = np.asarray(im)
    h, w, _ = a.shape
    pts = {"左上": a[3, 3], "右上": a[3, w - 4], "左下": a[h - 4, 3], "右下": a[h - 4, w - 4],
           "上中": a[3, w // 2], "下中": a[h - 4, w // 2]}
    print("  %-20s %dx%d  " % (name, w, h) + "  ".join("%s=%s" % (k, tuple(int(v) for v in p)) for k, p in pts.items()))


print("=== 四角背景色 ===")
for nm in ("_source.png", "_source-open.png", "_source-shut.png", "_source-hips.png"):
    corners(nm)

base = Image.open(os.path.join(ASSET, "_source.png")).convert("RGBA")
bw, bh = base.size
print()
print("=== 与 _source.png 对齐后的差异（各自缩到 %dx%d 后比）===" % (bw, bh))
ba = np.asarray(base).astype(np.int16)
for nm in ("_source-open.png", "_source-shut.png", "_source-hips.png"):
    im = Image.open(os.path.join(ASSET, nm)).convert("RGBA").resize((bw, bh), Image.LANCZOS)
    a = np.asarray(im).astype(np.int16)
    d = np.abs(a[:, :, :3] - ba[:, :, :3]).max(axis=2)
    print("  %-20s 平均通道差 %.1f   超 40 的像素占 %.1f%%" % (nm, d.mean(), (d > 40).mean() * 100))

# 三联对照图：原图 / 睁开 / 闭合（都缩到 360 宽）
tiles = []
for nm in ("_source.png", "_source-open.png", "_source-shut.png"):
    im = Image.open(os.path.join(ASSET, nm)).convert("RGB")
    im = im.resize((360, int(im.height * 360 / im.width)), Image.LANCZOS)
    tiles.append(im)
H = max(t.height for t in tiles)
sheet = Image.new("RGB", (360 * 3 + 20, H), (240, 240, 240))
for i, t in enumerate(tiles):
    sheet.paste(t, (i * 370, 0))
sheet.save(os.path.join(TOOLS, "_qa-align.png"))
print()
print("对照图 tools/_qa-align.png  （左：原眯眼  中：双眼睁开  右：双眼闭合）")
