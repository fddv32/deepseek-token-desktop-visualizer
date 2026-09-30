# -*- coding: utf-8 -*-
"""从四张透明素材合成傻鱼的整套动作帧。

素材（都由 make-shayu-sticker.py 产出）：
  _sticker-open.png   双眼睁开 · 剪刀手 —— **待机主体**
  _sticker-shut.png   双眼闭合 —— 只用来提供眼部像素
  _sticker.png        眯眼 · 剪刀手（原画）—— 只用来提供眼部像素
  _sticker-hips.png   双手叉腰 —— 空闲小动作

## 三个关键设计

**① 表情靠「贴眼睛」，不整张换图。**
闭眼/眯眼那两张是 AI 重绘的，轮廓虽然对齐（alpha 平均差 0.3%），但**整张图的
像素都跟睁开版不一样**（发梢、蕾丝这些高频处差得最多）。整张换过去的话，眨眼
会变成「整个人闪一下」。所以只用睁开版当底，把它眼睛那一块换成闭/眯版的像素 ——
差异权重当蒙版、再羽化，其余像素逐字节相同，切帧没有抖动。

**② 四张图先对齐到同一个「公共空间」再谈动画。**
对齐变换是轮廓互相关求出来的。不这么做的话，帧生成器按各自高度归一化，
四个姿势之间就会整体错位、大小不一。

**③ 底边锚定做挤压，锚点用「该姿势自己的下沿」。**
否则「蹲下」看起来像整体缩小。

## 输出目录（每套动作一个文件夹，渲染端按名字拼路径）

  frames/idle-01..08.png      frames/blink-01..04.png
  frames/acting-01..08.png    frames/hips-01..08.png
  frames/happy-01..04.png     frames/pain-weak-01..06.png
  frames/pain-normal-01..06.png
  frames/critical-01..06.png  frames/revive-01..07.png
  states/critical-combo.png
  idle.png（托盘图标）

另出 tools/_qa-frames.png 接触印相表。
"""
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

sys.stdout.reconfigure(encoding="utf-8")

ROOT = r"D:\WhalePet"
ASSET = os.path.join(ROOT, "assets", "shayu")
TOOLS = os.path.join(ROOT, "tools")

# ---- 画布与公共空间 ----
CANVAS = (420, 480)      # 帧画布（渲染端按这个比例铺满桌宠区）
K = 0.49                 # 公共空间 → 画布
PAD = 80                 # 公共空间四周留白：给旋转/缩放留余量，避免切边
ANCHOR_X = 432           # 公共空间的水平锚点（人头中心附近），所有姿势共用
OY = 33.3                # 公共空间原点在画布上的纵向位置
OX = CANVAS[0] / 2 - ANCHOR_X * K

# 每个姿势：源图 → 缩放 → 平移 → 裁到第几行
POSES = {
    "open": dict(src="_sticker-open.png", scale=1.00, off=(0, 0), crop=None),
    "shut": dict(src="_sticker-shut.png", scale=1.00, off=(0, 0), crop=None),
    "wink": dict(src="_sticker.png", scale=1.04, off=(11, 3), crop=None),
    # 叉腰：裁到裙摆下沿。不裁的话整张是全身站姿（903 行），比上半身姿势高一大截，
    # 同一个头身比下画布得长 1.2 倍，待机就会被顶得离信息条很远。裁掉腿部之后
    # 头身比与待机一致，切姿势时不会「跳」。
    "hips": dict(src="_sticker-hips.png", scale=1.00, off=(19, 1), crop=795),
}
# 公共空间尺寸：够放下所有姿势 + 平移 + 留白
COMMON = (820 + 2 * PAD, 830 + 2 * PAD)

RED = (255, 70, 70)
GLOW_C = (255, 244, 205)


def load_common():
    """把四张素材按 POSES 的变换放进同一个公共空间。"""
    out = {}
    for key, p in POSES.items():
        im = Image.open(os.path.join(ASSET, p["src"])).convert("RGBA")
        if p["crop"]:
            im = im.crop((0, 0, im.width, p["crop"]))
        s = p["scale"]
        if s != 1.0:
            im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
        canvas = Image.new("RGBA", COMMON, (0, 0, 0, 0))
        canvas.alpha_composite(im, (PAD + p["off"][0], PAD + p["off"][1]))
        out[key] = canvas
    return out


def eye_weight(base, other, sigma=6, lo=25, hi=75):
    """base 与 other 的差异权重（0~1）。只在眼睛附近有值。"""
    b = np.asarray(base.convert("RGB")).astype(np.float32)
    o = np.asarray(other.convert("RGB")).astype(np.float32)
    d = np.abs(b - o).max(axis=2)
    d = np.asarray(Image.fromarray(d.astype(np.uint8)).filter(ImageFilter.GaussianBlur(sigma))).astype(np.float32)
    w = np.clip((d - lo) / (hi - lo), 0.0, 1.0)
    return np.asarray(Image.fromarray((w * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(4))).astype(np.float32) / 255.0


def blend_eyes(base, other, w):
    """把 other 的眼睛按权重 w 贴到 base 上，alpha 沿用 base。"""
    b = np.asarray(base).astype(np.float32)
    o = np.asarray(other).astype(np.float32)
    m = w[:, :, None]
    rgb = b[:, :, :3] * (1 - m) + o[:, :, :3] * m
    return Image.fromarray(np.dstack([rgb, b[:, :, 3]]).clip(0, 255).astype(np.uint8), "RGBA")


def tint(im, color, amount):
    if amount <= 0:
        return im
    a = np.asarray(im).astype(np.float32)
    a[:, :, :3] = a[:, :, :3] * (1 - amount) + np.array(color, dtype=np.float32) * amount
    return Image.fromarray(a.clip(0, 255).astype(np.uint8), "RGBA")


def dim(im, factor):
    if factor >= 1:
        return im
    a = np.asarray(im).astype(np.float32)
    a[:, :, :3] *= factor
    return Image.fromarray(a.clip(0, 255).astype(np.uint8), "RGBA")


def glow(im, amount, color=GLOW_C):
    if amount <= 0:
        return im
    alpha = im.getchannel("A").filter(ImageFilter.GaussianBlur(14))
    halo = Image.new("RGBA", im.size, color + (0,))
    halo.putalpha(alpha.point(lambda v: int(v * amount)))
    out = Image.new("RGBA", im.size, (0, 0, 0, 0))
    out.alpha_composite(halo)
    out.alpha_composite(im)
    return out


def blend_at(dst, src, x, y):
    """把 src 贴到 dst 的 (x, y)，允许坐标越界（越界部分裁掉）。"""
    x, y = int(round(x)), int(round(y))
    sx0, sy0 = max(0, -x), max(0, -y)
    dx0, dy0 = max(0, x), max(0, y)
    w = min(src.width - sx0, dst.width - dx0)
    h = min(src.height - sy0, dst.height - dy0)
    if w <= 0 or h <= 0:
        return
    dst.alpha_composite(src.crop((sx0, sy0, sx0 + w, sy0 + h)), (dx0, dy0))


def render(base, bottom, scale=1.0, squeeze_y=1.0, squeeze_x=1.0, rot=0.0,
           dx=0, dy=0, tint_color=None, tint_amount=0.0, dim_factor=1.0, glow_amount=0.0):
    """把公共空间里的一张姿势图变换后放进画布。

    bottom —— 该姿势下沿在公共空间里的行号；挤压/缩放**以它为锚**，所以「蹲下」是
    往下压而不是整体缩小、下沿不动。
    """
    sx = K * scale * squeeze_x
    sy = K * scale * squeeze_y
    w, h = max(1, round(base.width * sx)), max(1, round(base.height * sy))
    im = base.resize((w, h), Image.LANCZOS)
    if tint_color:
        im = tint(im, tint_color, tint_amount)
    im = dim(im, dim_factor)
    im = glow(im, glow_amount)

    # 公共空间点 (px,py) 在缩放后的图里位于 (px*sx, py*sy)；目标落在画布
    # (OX + px*K, OY + py*K)。旋转绕锚点做，再把锚点平移到目标位。
    px, py = ANCHOR_X * sx, bottom * sy
    tx = OX + ANCHOR_X * K + dx
    ty = OY + bottom * K + dy
    if rot:
        im = im.rotate(rot, resample=Image.BICUBIC, center=(px, py),
                       translate=(tx - px, ty - py), fillcolor=(0, 0, 0, 0))
        x, y = 0, 0
    else:
        x, y = tx - px, ty - py
    canvas = Image.new("RGBA", CANVAS, (0, 0, 0, 0))
    blend_at(canvas, im, x, y)
    return canvas


# ---------------- 各动作的帧定义 ----------------

def build_frames():
    C = load_common()
    OPEN, SHUT, WINK, HIPS = C["open"], C["shut"], C["wink"], C["hips"]
    BOT = PAD + 746          # 上半身三张的下沿
    BOT_HIPS = PAD + 795     # 叉腰（裁过）的下沿

    # 表情：只换眼睛那一块
    w_shut = eye_weight(OPEN, SHUT)
    w_wink = eye_weight(OPEN, WINK)
    E = {
        "open": OPEN,
        "shut": blend_eyes(OPEN, SHUT, w_shut),
        "half": blend_eyes(OPEN, SHUT, w_shut * 0.55),   # 半闭，眨眼过渡用
        "wink": blend_eyes(OPEN, WINK, w_wink),
    }
    n_eye = int((w_shut > 0.05).sum())
    print("  眼部蒙版 %d px（占画面 %.2f%%）" % (n_eye, n_eye / (COMMON[0] * COMMON[1]) * 100))

    def R(expr, **kw):
        return render(E[expr], BOT, **kw)

    frames = {}

    # 待机：呼吸。挤压以底边为基准 → 头顶轻微起伏，裙摆不动
    frames["idle"] = [R("open", squeeze_y=s, rot=r)
                      for s, r in [(1.000, 0.0), (1.004, 0.4), (1.008, 0.7), (1.010, 0.8),
                                   (1.008, 0.6), (1.004, 0.3), (1.000, 0.0), (0.997, -0.3)]]

    # 眨眼：真·眨眼 —— 半闭 → 闭 → 半闭 → 睁。225ms，再长就不像眨眼了
    frames["blink"] = [R("half", squeeze_y=0.995), R("shut"),
                       R("half", squeeze_y=0.995), R("open", squeeze_y=1.004)]

    # 小动作：自己晃一下（左倾再回正），末帧接近中立，切回待机不突兀
    frames["acting"] = [R("open", rot=r, dy=d, squeeze_y=s)
                        for r, d, s in [(0.0, 0, 1.000), (-1.8, -2, 1.004), (-2.8, -4, 1.006),
                                        (-2.0, -3, 1.004), (-0.8, -1, 1.002), (0.9, 1, 1.000),
                                        (0.5, 0, 0.999), (0.0, 0, 1.000)]]

    # 叉腰：落定 → 微微起伏 → 回正（用它自己的下沿当锚，裙摆不飘）
    frames["hips"] = [render(HIPS, BOT_HIPS, squeeze_y=s, squeeze_x=x, dy=d, rot=r)
                      for s, x, d, r in [(0.986, 1.012, 3, -0.8), (1.004, 0.997, -2, 0.5),
                                         (1.010, 0.994, -3, 0.7), (1.006, 0.996, -2, 0.4),
                                         (1.000, 1.000, 0, 0.0), (0.995, 1.004, 1, -0.2),
                                         (0.999, 1.001, 0, -0.1), (1.000, 1.000, 0, 0.0)]]

    # 开心（双击）：蹲 → 滞空（这时眯眼笑）→ 落地 → 回正
    frames["happy"] = [R("open", squeeze_y=0.975, squeeze_x=1.015),
                       R("wink", dy=-26),
                       R("open", squeeze_y=0.965, squeeze_x=1.022, dy=1),
                       R("open", squeeze_y=1.005, dy=-2)]

    # 受击：左右抖动；普通痛与暴击再叠一层泛红
    frames["pain-weak"] = [R("open", dx=dx, dy=dy, rot=r, squeeze_y=s)
                           for dx, dy, r, s in [(0, 0, 0.0, 1.000), (-4, 3, -1.2, 0.986),
                                                (3, 2, 1.0, 0.991), (-3, 3, -0.8, 0.988),
                                                (2, 1, 0.5, 0.995), (0, 0, 0.0, 1.000)]]
    frames["pain-normal"] = [R("open", dx=dx, dy=dy, rot=r, squeeze_y=s,
                               tint_color=RED, tint_amount=t)
                             for dx, dy, r, s, t in [(0, 0, 0.0, 1.000, 0.0), (-6, 6, -1.8, 0.972, 0.10),
                                                     (5, 4, 1.5, 0.982, 0.07), (-5, 5, -1.4, 0.976, 0.05),
                                                     (3, 2, 0.8, 0.990, 0.03), (0, 0, 0.0, 1.000, 0.0)]]

    # 暴击：抖得最狠 + 泛红。首帧刻意就不是中立姿态 —— 否则事件到达后 260ms 毫无变化，
    # 抓帧对比起来就像「动画根本没播」。
    frames["critical"] = [R("open", dx=dx, dy=dy, rot=r, squeeze_y=s, tint_color=RED, tint_amount=t)
                          for dx, dy, r, s, t in [(-4, 5, -1.0, 0.975, 0.12), (-7, 9, -1.6, 0.958, 0.20),
                                                  (6, 6, 1.4, 0.972, 0.15), (-6, 7, -1.2, 0.962, 0.11),
                                                  (4, 3, 0.7, 0.985, 0.06), (0, 0, 0.0, 1.000, 0.0)]]

    # 复苏：从瘫软一路亮起来
    frames["revive"] = [R("open", squeeze_y=0.92, squeeze_x=1.025, dy=8, dim_factor=0.68,
                          tint_color=RED, tint_amount=0.10),
                        R("open", squeeze_y=0.95, squeeze_x=1.016, dy=4, dim_factor=0.82, glow_amount=0.20),
                        R("open", squeeze_y=0.99, dy=-2, dim_factor=0.92, glow_amount=0.30),
                        R("open", scale=1.02, dy=-6, glow_amount=0.26),
                        R("open", dy=0, glow_amount=0.14),
                        R("open", squeeze_y=0.995, dy=1, glow_amount=0.06),
                        R("open", dy=-8, squeeze_y=1.004)]

    states = {
        "critical-combo": R("open", squeeze_y=0.93, squeeze_x=1.022, rot=-1.2, dy=4,
                            dim_factor=0.84, tint_color=RED, tint_amount=0.12),
    }
    return frames, states, frames["idle"][0]


# ---------------- 落盘 ----------------

CLIP_WARN = 16
_clipped = []


def save(im, *rel):
    a = np.asarray(im)[:, :, 3]
    edges = {"上": int(a[0, :].max()), "下": int(a[-1, :].max()),
             "左": int(a[:, 0].max()), "右": int(a[:, -1].max())}
    bad = {k: v for k, v in edges.items() if v > CLIP_WARN}
    if bad:
        _clipped.append(("/".join(rel), bad))
    p = os.path.join(ASSET, *rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    im.save(p, optimize=True)
    return p


if __name__ == "__main__":
    print("=== 合成傻鱼动作帧 ===")
    frames, states, tray = build_frames()

    written = []
    for name, ims in frames.items():
        for i, im in enumerate(ims, 1):
            written.append(save(im, "frames", "%s-%02d.png" % (name, i)))
    for name, im in states.items():
        written.append(save(im, "states", name + ".png"))
    written.append(save(tray, "idle.png"))

    print("写出 %d 帧，共 %.1f KB" % (len(written), sum(os.path.getsize(p) for p in written) / 1024))
    if _clipped:
        print("!! 有帧被画布裁到（要收幅度或加留白）:")
        for rel, bad in _clipped:
            print("   %-40s %s" % (rel, bad))
    else:
        print("裁切自检：%d 帧全部完整，没有内容贴到画布边缘" % len(written))

    # 接触印相表
    order = ["idle", "blink", "acting", "hips", "happy", "pain-weak", "pain-normal", "critical", "revive"]
    cols = max(len(frames[k]) for k in order)
    cell = 96
    sheet = Image.new("RGB", (cols * cell + 96, len(order) * (cell + 16) + 10), (24, 28, 40))
    d = ImageDraw.Draw(sheet)
    for r, name in enumerate(order):
        y = 8 + r * (cell + 16)
        d.text((6, y + cell // 2), name, fill=(255, 220, 120))
        for c, im in enumerate(frames[name]):
            th = im.resize((cell, int(im.height * cell / im.width)), Image.LANCZOS)
            sheet.paste(th.convert("RGB"), (96 + c * cell, y), th.split()[3].point(lambda v: int(v * 0.85)))
    sheet.save(os.path.join(TOOLS, "_qa-frames.png"))
    print("质检图 tools/_qa-frames.png", sheet.size)
