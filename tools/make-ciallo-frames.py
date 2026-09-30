# -*- coding: utf-8 -*-
"""从「只有一张图」的贴纸程序化生成整套动画帧。

背景：新形象只有一张静态图（眨眼 + 剪刀手），没有原插件那种分帧素材。
与其砍掉动画，不如用变换合成出一套帧 —— 平移 / 缩放 / 旋转 / 挤压 / 染色，
输出成**真实 PNG 帧文件**，目录结构照抄原素材的约定，
这样渲染端的帧扫描 + 状态机一行都不用改。

挤压/跳跃都以**底边为基准**（bottom-anchored），否则「蹲下」会看起来像整体缩小。

产物目录（assets/ciallo/）刻意沿用原素材的命名，main.js 的 frameGroups() 直接复用：
  idle-v4-r2/                  idle-01..08、blink-soft|half-close|reopen、acting-01..08
  happy/                       happy-01..04（多了这一组，见 main.js 的 happySeq）
  revive-recharge-v1/frames/   revive-*
  feedback-expression-v4-r5-critical-model/frames/  critical-*
  feedback-expression-v4-r4-model/frames/           weak-*、normal-*
  death-stranded-v6-trim.png、critical-combo-pain-v2.png、idle-hands.png

另出 tools/_qa-frames.png 接触印相表，一眼看完所有帧。
"""
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

sys.stdout.reconfigure(encoding="utf-8")

ROOT = r"D:\WhalePet"
ASSET = os.path.join(ROOT, "assets", "ciallo")
SRC = os.path.join(ASSET, "_sticker.png")

CW, CH = 420, 480       # 帧画布。画布宽高比≈贴纸本身，避免两侧留无用空白
BASE_H = 380            # 贴纸在帧里的基准高度
BOTTOM_MARGIN = 26      # 底边基准线距画布底部的距离

sticker = Image.open(SRC).convert("RGBA")

# 基准宽**由贴纸实际宽高比算出**，别再写死比例。
# 写死过两次，两次都出事：素材一改（去字变宽、去白边变窄）算出的底宽就超过画布，
# **连静态帧都在切发梢**，而裁切自检要跑完 46 帧才报出来。
BASE_W = round(BASE_H * sticker.width / sticker.height)
# 横向余量要同时装下三种位移：
#     |dx| + h·sin|rot|/2 + w·(squeeze_x-1)/2  ≤  LATERAL_BUDGET
# 下面所有帧的 dx / rot / squeeze_x 幅度都照这个上限配 ——
# 宁可少晃一点、多用挤压和染色做出力度，也不要切掉发梢。
LATERAL_BUDGET = (CW - BASE_W) // 2
print("贴纸 %d×%d  →  基准 %d×%d，横向位移上限 ±%d"
      % (sticker.width, sticker.height, BASE_W, BASE_H, LATERAL_BUDGET))


def tint(im, color, amount):
    """把颜色朝 color 混合 amount（0~1），保留 alpha。"""
    if amount <= 0:
        return im
    a = np.asarray(im).astype(np.float32)
    rgb = a[:, :, :3]
    target = np.array(color, dtype=np.float32)
    a[:, :, :3] = rgb * (1 - amount) + target * amount
    return Image.fromarray(a.clip(0, 255).astype(np.uint8), "RGBA")


def dim(im, factor):
    if factor >= 1:
        return im
    a = np.asarray(im).astype(np.float32)
    a[:, :, :3] *= factor
    return Image.fromarray(a.clip(0, 255).astype(np.uint8), "RGBA")


def glow(im, amount, color=(255, 244, 205)):
    """在角色后面垫一层柔光（复苏/治疗用）。"""
    if amount <= 0:
        return im
    alpha = im.getchannel("A").filter(ImageFilter.GaussianBlur(14))
    halo = Image.new("RGBA", im.size, color + (0,))
    halo.putalpha(alpha.point(lambda v: int(v * amount)))
    out = Image.new("RGBA", im.size, (0, 0, 0, 0))
    out.alpha_composite(halo)
    out.alpha_composite(im)
    return out


def render(scale=1.0, squeeze_y=1.0, squeeze_x=1.0, rot=0.0, dx=0, dy=0,
           tint_color=None, tint_amount=0.0, dim_factor=1.0, glow_amount=0.0):
    h = max(1, round(BASE_H * scale * squeeze_y))
    w = max(1, round(BASE_W * scale * squeeze_x))
    im = sticker.resize((w, h), Image.LANCZOS)
    if rot:
        # expand=True：旋转放大画布，避免把发梢/尾巴切掉
        im = im.rotate(rot, resample=Image.BICUBIC, expand=True, fillcolor=(0, 0, 0, 0))
    im = tint(im, tint_color, tint_amount) if tint_color else im
    im = dim(im, dim_factor)
    im = glow(im, glow_amount)
    canvas = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
    x = round((CW - im.width) / 2) + dx
    y = (CH - BOTTOM_MARGIN) - im.height + dy     # 底边对齐基准线
    canvas.alpha_composite(im, (x, y))
    return canvas


RED = (255, 70, 70)

# ---------------- 各状态的帧定义 ----------------
# idle：呼吸。挤压以底边为基准 → 头顶轻微起伏，脚不动，比整体位移自然。
IDLE = [render(squeeze_y=s, rot=r)
        for s, r in [(1.000, 0.0), (1.004, 0.4), (1.008, 0.7), (1.010, 0.8),
                     (1.008, 0.6), (1.004, 0.3), (1.000, 0.0), (0.997, -0.3)]]

# blink：这张图本来就是睁一只眼闭一只眼，做不了真正的眨眼，
# 改成一次极轻的「点头」——每几秒来一下，读起来是活的小动作而不是呆照。
BLINK = {
    "blink-soft": render(),
    "blink-half-close": render(squeeze_y=0.988),
    "blink-reopen": render(squeeze_y=1.006, dy=-2),
}

# acting：自己晃一下（左倾再回正），末帧接近中立姿态，切回 idle 不突兀
ACTING = [render(rot=r, dy=d, squeeze_y=s)
          for r, d, s in [(0.0, 0, 1.000), (-1.8, -2, 1.004), (-2.8, -4, 1.006),
                          (-2.0, -3, 1.004), (-0.8, -1, 1.002), (0.9, 1, 1.000),
                          (0.5, 0, 0.999), (0.0, 0, 1.000)]]

# happy：双击时的蹦高。HAPPY_MS = [155, 825, 80, 85] →
# 蹲 → 滞空(停留最久，所以那一帧要最「高」) → 落地 → 回正
# 注意幅度上限：底边基准线在 454，BASE_H=380，向上有 74px 余量，
# dy=-26 用掉一部分；再加 scale 会把头顶的呆毛切掉，所以滞空帧不加 scale。
HAPPY = [render(squeeze_y=0.975, squeeze_x=1.015),
         render(dy=-26),
         render(squeeze_y=0.965, squeeze_x=1.022, dy=1),
         render(squeeze_y=1.005, dy=-2)]

# pain：PAIN_MS 六拍 [150,470,70,100,80,80]，左右抖动 + 轻微下压
PAIN_WEAK = [render(dx=dx, dy=dy, rot=r, squeeze_y=s)
             for dx, dy, r, s in [(0, 0, 0.0, 1.000), (-4, 3, -1.2, 0.986),
                                  (3, 2, 1.0, 0.991), (-3, 3, -0.8, 0.988),
                                  (2, 1, 0.5, 0.995), (0, 0, 0.0, 1.000)]]
PAIN_NORMAL = [render(dx=dx, dy=dy, rot=r, squeeze_y=s,
                      tint_color=RED, tint_amount=t)
               for dx, dy, r, s, t in [(0, 0, 0.0, 1.000, 0.0), (-6, 6, -1.8, 0.972, 0.10),
                                       (5, 4, 1.5, 0.982, 0.07), (-5, 5, -1.4, 0.976, 0.05),
                                       (3, 2, 0.8, 0.990, 0.03), (0, 0, 0.0, 1.000, 0.0)]]

# critical：每帧 260ms，抖得最狠 + 泛红，末两帧收回来。
# 旋转会把画布撑大（392 宽转 1.6° 后约 +10px），横向余量只有 14px，
# 所以这条线的「力度」主要靠 squeeze + 染色，位移只留 ±7。
# 首帧（critical-notice）**刻意不是中立姿态**：原来它是 tint=0 / 位移=0，
# 而它占满 260ms，结果事件到达后画面整整 260ms 毫无变化 —— 抓帧对比时
# 看起来就像「受击动画根本没播」。反馈类动画的第一帧就该已经在反应。
CRITICAL = [render(dx=dx, dy=dy, rot=r, squeeze_y=s, tint_color=RED, tint_amount=t)
            for dx, dy, r, s, t in [(-4, 5, -1.0, 0.975, 0.12), (-7, 9, -1.6, 0.958, 0.20),
                                    (6, 6, 1.4, 0.972, 0.15), (-6, 7, -1.2, 0.962, 0.11),
                                    (4, 3, 0.7, 0.985, 0.06), (0, 0, 0.0, 1.000, 0.0)]]

# 暴击收尾那一帧（critical 片段末尾追加 500ms）：泄气地瘫一下
CRITICAL_COMBO = render(squeeze_y=0.93, squeeze_x=1.022, rot=-1.2, dy=4,
                        dim_factor=0.84, tint_color=RED, tint_amount=0.12)

# revive：每帧 340ms，从瘫倒一路亮起来（顺序即文件名顺序）
REVIVE = {
    "revive-death-start": render(squeeze_y=0.92, squeeze_x=1.025, dy=8,
                                 dim_factor=0.68, tint_color=RED, tint_amount=0.10),
    "revive-wake": render(squeeze_y=0.95, squeeze_x=1.016, dy=4, dim_factor=0.82, glow_amount=0.20),
    "revive-lift": render(squeeze_y=0.99, dy=-2, dim_factor=0.92, glow_amount=0.30),
    "revive-relief": render(scale=1.02, dy=-6, glow_amount=0.26),
    "revive-reopen": render(dy=0, glow_amount=0.14),
    "revive-settle": render(squeeze_y=0.995, dy=1, glow_amount=0.06),
    "revive-hop": render(dy=-8, squeeze_y=1.004),
}

DEATH = render(squeeze_y=0.90, squeeze_x=1.020, rot=-1.5, dy=10,
               dim_factor=0.60, tint_color=(120, 130, 170), tint_amount=0.18)

IDLE_HANDS = render()   # 默认不启用（WHALEPET_DRAG_POSE=1 才会用到）


# ---------------- 落盘 ----------------
CLIP_WARN = 16   # 画布边缘 alpha 超过这个值就认为内容被裁到
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


written = []
IDLE_DIR = ("idle-v4-r2",)
for i, im in enumerate(IDLE, 1):
    written.append(save(im, *IDLE_DIR, "idle-%02d.png" % i))
for name, im in BLINK.items():
    written.append(save(im, *IDLE_DIR, name + ".png"))
for i, im in enumerate(ACTING, 1):
    written.append(save(im, *IDLE_DIR, "acting-%02d.png" % i))
for i, im in enumerate(HAPPY, 1):
    written.append(save(im, "happy", "happy-%02d.png" % i))
for name, im in REVIVE.items():
    written.append(save(im, "revive-recharge-v1", "frames", name + ".png"))
for i, name in enumerate(["critical-notice", "critical-brace", "critical-overflow",
                          "critical-peak", "critical-comfort", "critical-recover"]):
    written.append(save(CRITICAL[i], "feedback-expression-v4-r5-critical-model", "frames", name + ".png"))
for name in ["weak-half", "weak-close", "weak-reopen"]:
    idx = {"weak-half": 1, "weak-close": 3, "weak-reopen": 5}[name]
    written.append(save(PAIN_WEAK[idx], "feedback-expression-v4-r4-model", "frames", name + ".png"))
for name in ["normal-half", "normal-close", "normal-reopen"]:
    idx = {"normal-half": 1, "normal-close": 3, "normal-reopen": 5}[name]
    written.append(save(PAIN_NORMAL[idx], "feedback-expression-v4-r4-model", "frames", name + ".png"))
written.append(save(DEATH, "death-stranded-v6-trim.png"))
written.append(save(CRITICAL_COMBO, "critical-combo-pain-v2.png"))
written.append(save(IDLE_HANDS, "idle-hands.png"))
# 托盘图标用顶层 idle.png（main.js 的 buildTray 优先找它）
written.append(save(IDLE[0], "idle.png"))

print("写出 %d 帧，共 %.1f KB" % (len(written), sum(os.path.getsize(p) for p in written) / 1024))
if _clipped:
    print("!! 有帧被画布裁到（需要收幅度或加画布余量）:")
    for rel, bad in _clipped:
        print("   %-70s %s" % (rel, bad))
else:
    print("裁切自检：%d 帧全部完整，没有内容贴到画布边缘" % len(written))

# ---------------- 接触印相表 ----------------
groups = [("idle 待机", IDLE), ("blink 点头", list(BLINK.values())), ("acting 小动作", ACTING),
          ("happy 双击", HAPPY), ("pain-weak 轻痛", PAIN_WEAK), ("pain-normal 普通痛", PAIN_NORMAL),
          ("critical 暴击", CRITICAL), ("revive 复苏", list(REVIVE.values()))]
cols = 8
cell = 110
sheet = Image.new("RGB", (cols * cell + 80, len(groups) * (cell + 18) + 10), (24, 28, 40))
d = ImageDraw.Draw(sheet)
for r, (label, frames) in enumerate(groups):
    y = 8 + r * (cell + 18)
    d.text((6, y + cell // 2), label, fill=(255, 220, 120))
    for c, im in enumerate(frames[:cols]):
        th = im.resize((int(im.width * cell / max(im.width, im.height)),
                        int(im.height * cell / max(im.width, im.height))), Image.LANCZOS)
        sheet.paste(th, (80 + c * cell, y), th)
sheet.save(os.path.join(ROOT, "tools", "_qa-frames.png"))
print("质检图 tools/_qa-frames.png", sheet.size)
