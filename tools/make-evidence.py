# 生成「拖动问题」修复对照证据图（诊断用，不属于桌宠运行时）
#
# 输入：
#   - 用户反馈截图（image-cache 里的原图）
#   - 素材 assets/whale-girl/idle-hands.png（旧版拖动姿态）
#   - 验收器 tools/drag-verify.py 产出的 tools/ab/result-<tag>.json（每张截图都带窗口矩形）
# 输出：
#   - tools/fix-evidence.png
#
# 用法：python make-evidence.py [tag] [--user-box l,t,r,b]

import io
import json
import os
import sys

from PIL import Image, ImageDraw

sys.stdout.reconfigure(encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AB = os.path.join(ROOT, "tools", "ab")
USER_SHOT = (
    "C:/Users/yaoweilin/.zcode/cli/image-cache/"
    "sess_e855c01d-b7d5-4758-8525-cfa28eeab563/"
    "image-09634b883709899985cbe5aa2c3f6d92.png"
)
# 用户截图里桌宠所在的矩形（2560x1440 物理像素）
USER_BOX = (1925, 455, 2280, 605)

TAG = "poll16"
for a in sys.argv[1:]:
    if a.startswith("--user-box="):
        USER_BOX = tuple(int(v) for v in a.split("=", 1)[1].split(","))
    elif not a.startswith("-"):
        TAG = a

FONT_PATHS = [
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/msyhbd.ttc",
    "C:/Windows/Fonts/simhei.ttf",
]


def font(size, bold=False):
    from PIL import ImageFont

    for p in FONT_PATHS:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


def wrap_cjk(text, fnt, max_w):
    """按像素宽度折行，中文没有空格，所以逐字累加。"""
    from PIL import ImageFont  # noqa: F401  (类型提示用，保持依赖显式)

    lines, cur = [], ""
    for ch in text:
        probe = cur + ch
        if cur and fnt.getlength(probe) > max_w:
            lines.append(cur)
            cur = ch
        else:
            cur = probe
    if cur:
        lines.append(cur)
    return lines


def alpha_bbox(im):
    box = im.split()[-1].getbbox()
    return box or (0, 0, im.width, im.height)


def contain(im, box_w, box_h):
    s = min(box_w / im.width, box_h / im.height)
    return im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))), Image.LANCZOS)


def on_checker(im, size=12):
    """把带透明通道的素材贴到浅灰棋盘格上，方便看清轮廓。"""
    out = Image.new("RGB", im.size, (255, 255, 255))
    d = ImageDraw.Draw(out)
    for y in range(0, im.height, size):
        for x in range(0, im.width, size):
            if ((x // size) + (y // size)) % 2:
                d.rectangle([x, y, x + size - 1, y + size - 1], fill=(240, 240, 243))
    out.paste(im, (0, 0), im)
    return out


def cell_from_rect(full, rect, pad=26):
    """按截图拍摄那一刻的窗口矩形裁剪桌宠（窗口会移动，所以必须逐张用各自的 rect）。
    同时把窗口外的桌面压暗并描边，让「窗口边界确实跟着光标动了」一眼可见。"""
    l, t, w, h = rect
    box = (
        max(0, l - pad),
        max(0, t - pad),
        min(full.width, l + w + pad),
        min(full.height, t + h + pad),
    )
    crop = full.crop(box).convert("RGB")

    # 窗口矩形在裁剪图里的位置
    wx0, wy0 = l - box[0], t - box[1]
    wx1, wy1 = wx0 + w, wy0 + h

    dim = Image.new("RGB", crop.size, (250, 250, 252))
    mask = Image.new("L", crop.size, 200)  # 窗口外压暗 78%
    ImageDraw.Draw(mask).rectangle([wx0, wy0, wx1 - 1, wy1 - 1], fill=0)
    crop = Image.composite(dim, crop, mask)

    d = ImageDraw.Draw(crop)
    for xx in range(wx0, wx1, 14):
        d.line([(xx, wy0), (min(xx + 7, wx1), wy0)], fill=(230, 60, 60), width=2)
        d.line([(xx, wy1 - 1), (min(xx + 7, wx1), wy1 - 1)], fill=(230, 60, 60), width=2)
    for yy in range(wy0, wy1, 14):
        d.line([(wx0, yy), (wx0, min(yy + 7, wy1))], fill=(230, 60, 60), width=2)
        d.line([(wx1 - 1, yy), (wx1 - 1, min(yy + 7, wy1))], fill=(230, 60, 60), width=2)
    return crop


def main():
    rp = os.path.join(AB, "result-%s.json" % TAG)
    with io.open(rp, encoding="utf-8") as fh:
        r = json.load(fh)
    shots = {s["name"]: s for s in r["shots"]}
    if not shots:
        print("没有可用截图")
        return 1

    def pick(*suffixes):
        for name in sorted(shots):
            if name.endswith(tuple(suffixes)):
                return name
        return None

    n_idle = pick("-idle")
    n_click = pick("-click")
    n_mid = pick("-drag-mid")
    n_held = pick("-held")
    n_rel = pick("-released")

    cache = {}

    def full_of(name):
        if name not in cache:
            cache[name] = Image.open(shots[name]["file"]).convert("RGB")
        return cache[name]

    CELL_W, CELL_H = 340, 340
    PAD = 18
    groups = []

    # ---- 第 1 组：用户看到的问题 vs 素材本身 ----
    u = Image.open(USER_SHOT).convert("RGB")
    u_crop = u.crop(USER_BOX)
    shown = contain(u_crop, CELL_W, CELL_H)
    hands = Image.open(os.path.join(ROOT, "assets", "whale-girl", "idle-hands.png")).convert("RGBA")
    hands = hands.crop(alpha_bbox(hands))
    hands = on_checker(contain(hands, CELL_W, CELL_H))
    groups.append(
        (
            "① 你看到的「拖动变形」＝ 旧版把姿态换成了 idle-hands.png（俯身双手前伸，缩小后像两个头）",
            [
                (shown, "你的截图 · 桌宠区域"),
                (hands, "素材 idle-hands.png（同一张图）"),
            ],
        )
    )

    # ---- 第 2 组：修复后拖动 ----
    drag_cells = []
    for nm, cap in ((n_mid, "拖动中"), (n_held, "按住横移后")):
        if not nm:
            continue
        drag_cells.append((contain(cell_from_rect(full_of(nm), shots[nm]["rect"]), CELL_W, CELL_H), "%s · 窗口矩形 %s" % (cap, shots[nm]["rect"])))
    if drag_cells:
        moved = r.get("moved")
        exp = r.get("expectedMoved")
        groups.append(
            (
                "② 修复后 · 拖动：窗口整块跟着光标走，姿态不再切换（实际位移 %s / 预期 %s）" % (moved, exp),
                drag_cells,
            )
        )

    # ---- 第 3 组：修复后单击 ----
    click_cells = []
    for nm, cap in ((n_click, "单击摸头（播原插件疼痛帧）"), (n_rel, "松手后回到待机")):
        if not nm:
            continue
        click_cells.append((contain(cell_from_rect(full_of(nm), shots[nm]["rect"]), CELL_W, CELL_H), cap))
    if click_cells:
        groups.append(("③ 修复后 · 单击：表情来自插件自带帧序列", click_cells))

    ncols = max(len(g[1]) for g in groups)
    W = PAD + ncols * (CELL_W + PAD)

    f_title = font(16, True)
    f_cap = font(13)
    TITLE_LINE_H = 24
    CAP_H = 22

    # 先算每行高度（行内取最高的一张，避免留白）
    laid_out = []
    for title, cells in groups:
        tlines = wrap_cjk(title, f_title, W - 2 * PAD - 20)
        row_h = max(img.height for img, _ in cells)
        laid_out.append((tlines, cells, row_h))

    H = PAD + sum(len(t) * TITLE_LINE_H + 10 + row_h + CAP_H + PAD for t, _, row_h in laid_out)
    canvas = Image.new("RGB", (W, H), (255, 255, 255))
    d = ImageDraw.Draw(canvas)

    y = PAD
    for tlines, cells, row_h in laid_out:
        pad_l = PAD + 10
        d.rectangle([PAD, y, W - PAD, y + len(tlines) * TITLE_LINE_H + 4], fill=(244, 246, 250))
        for i, ln in enumerate(tlines):
            d.text((pad_l, y + i * TITLE_LINE_H + 2), ln, fill=(28, 34, 48), font=f_title)
        y += len(tlines) * TITLE_LINE_H + 10
        for i, (img, cap) in enumerate(cells):
            x = PAD + i * (CELL_W + PAD)
            d.rectangle([x - 1, y - 1, x + img.width, y + img.height], outline=(214, 220, 230))
            canvas.paste(img, (x, y))
            d.text((x + 2, y + row_h + 5), cap, fill=(96, 104, 120), font=f_cap)
        y += row_h + CAP_H + PAD

    out = os.path.join(ROOT, "tools", "fix-evidence.png")
    canvas.save(out)
    print("saved", out, canvas.size, "moved", r.get("moved"), "steps", r.get("stepsUsed"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
