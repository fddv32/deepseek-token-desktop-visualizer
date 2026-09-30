# -*- coding: utf-8 -*-
"""抓「小 / 中 / 大」三个尺寸下桌宠窗口的真实像素，用来判断形象为什么会显得「太宽」。

为什么不能靠算：窗口尺寸（BASE_W × 420+信息条）和形象画布（420×480）比例不一样，
所以 #pet 的 contain 在两个尺寸之间会从「高度顶满」翻到「宽度顶满」——
翻过去之后鱼就不再随尺寸长高了，只是横向把窗口撑满。这段推理需要用真实截图确认，
计算里任何一个数（信息条高度、DPI、padding）错了，结论就会反。

用法：
    python tools/probe-scale.py                 # 默认 0.7 / 1.0 / 1.4
    python tools/probe-scale.py 0.7 0.9 1.2     # 指定尺寸
    python tools/probe-scale.py --keep-config   # 跑完不改回 config.json

产出：
    tools/scale-<tag>.png          每个尺寸一张窗口内容截图（原生像素，1.5× DPI）
    tools/scale-compare.png        对照图：① 各尺寸原样并排 ② 鱼身等高归一化
    终端会打印每个尺寸的窗口尺寸 / contain 结果 / 鱼身占窗口宽的比例
"""
import json
import os
import shutil
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS = os.path.join(ROOT, "tools")
CONFIG = os.path.join(ROOT, "config.json")
REPORT = os.path.join(TOOLS, "startup-report.json")
ELECTRON = os.path.join(ROOT, "node_modules", "electron", "dist", "electron.exe")

WAIT_MS = 2800
CAP_NAME = "capture-t%dms.png" % WAIT_MS

argv = [a for a in sys.argv[1:] if not a.startswith("--")]
KEEP = "--keep-config" in sys.argv
SCALES = [float(a) for a in argv] or [0.7, 1.0, 1.4]


def kill_tree(pid):
    subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)], capture_output=True)


def others_running():
    # tasklist 的输出按系统代码页（本机 GBK）编码，直接 text=True 会在解码上炸；
    # 要找的 'electron.exe' 是纯 ASCII，所以在 bytes 上比就够。
    out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq electron.exe", "/NH"],
                         capture_output=True).stdout or b""
    return b"electron.exe" in out.lower()


def run_one(scale, tag):
    """把一个尺寸的 config 写盘，起一次 electron，等窗口自己抓图。"""
    cfg = json.loads(open(CONFIG, encoding="utf-8").read())
    cfg["scale"] = scale
    cfg["x"], cfg["y"] = 60, 60
    open(CONFIG, "w", encoding="utf-8").write(json.dumps(cfg, ensure_ascii=False, indent=2))

    shot = os.path.join(TOOLS, CAP_NAME)
    if os.path.exists(shot):
        os.remove(shot)
    open(REPORT, "w", encoding="utf-8").write("")

    env = dict(os.environ)
    env.pop("ELECTRON_RUN_AS_NODE", None)   # 宿主 shell 里带这个，electron 会当纯 Node 跑
    env.pop("NODE_OPTIONS", None)
    env["WHALEPET_REPORT"] = "1"
    env["WHALEPET_CAPTURE"] = "1"
    env["WHALEPET_CAPTURE_MS"] = str(WAIT_MS)

    p = subprocess.Popen([ELECTRON, "."], cwd=ROOT, env=env,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    saved = False
    t0 = time.time()
    while time.time() - t0 < 30:
        time.sleep(0.3)
        if not os.path.exists(shot):
            continue
        try:
            # 必须用 replace 而不是 rename：Windows 上 rename 撞到已存在的目标会直接抛
            # FileExistsError（不覆盖），第二次跑就一张图都拿不到。
            os.replace(shot, os.path.join(TOOLS, "scale-%s.png" % tag))
        except OSError:
            continue  # 还在写，下一轮
        saved = True
        break

    # 只杀本次这一棵进程树：本机上还有别的 Electron 程序在跑，taskkill /IM 会误伤
    kill_tree(p.pid)
    time.sleep(1.0)
    if p.poll() is None:
        p.kill()

    geo = None
    try:
        d = json.loads(open(REPORT, encoding="utf-8").read())
        for s in d.get("steps", []):
            if isinstance(s, dict) and s.get("step") == "createWindow:geometry":
                geo = s
    except Exception:
        pass
    print("  尺寸 %-4s 窗口 %sx%s  report=%s  图=%s"
          % (scale, (geo or {}).get("w"), (geo or {}).get("h"),
             "有" if geo else "无", "有" if saved else "无"))
    return saved


def measure(path):
    """量窗口里「鱼」的可见包围盒和它底边到信息条的距离。

    截的是窗口内容（capturePage），透明区 alpha=0，所以取 alpha 的 bbox 就是鱼的外轮廓。
    难点是**别把信息条量进去**：它不是鱼，而且铺满整个窗口宽。
    固定的百分比裁不了 —— 信息条高度是渲染端按内容量出来的，各档还不一样；
    实测踩过：按 72% 裁，中档直接把鱼的下半身裁掉了，量出来的长宽比 0.89（真值 1.008）。
    改成从底部往上找：信息条最上面那一行的左边缘会贴到窗口左边（圆角胶囊），
    鱼最宽也就在窗口宽 85% 左右，够不着那儿。
    """
    from PIL import Image
    im = Image.open(path).convert("RGBA")
    a = im.split()[-1]
    W, H = im.size

    bar_top = H
    for y in range(H - 1, 0, -1):
        bb = a.crop((0, y, W, y + 1)).getbbox()
        if bb and bb[0] < 0.08 * W:
            bar_top = y
        elif not bb:
            break

    bb = a.crop((0, 0, W, bar_top)).getbbox()
    return im, (bb or (0, 0, W, bar_top)), bar_top


def compose(rows):
    """左边一列原样并排（对齐底边，带窗口描边），右边一列把鱼身缩到等高比宽窄。"""
    from PIL import Image, ImageDraw, ImageFont

    def font(sz):
        for pth in ("C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simhei.ttf"):
            if os.path.exists(pth):
                try:
                    return ImageFont.truetype(pth, sz)
                except Exception:
                    pass
        return ImageFont.load_default()

    f = font(15)
    f2 = font(13)
    PAD = 16
    COL_W = 190          # 左侧原样并排里的最大窗口宽
    NORM_H = 220         # 右侧归一化的鱼身高

    cells = []
    for tag, path, im, bb in rows:
        s = min(COL_W / im.width, 300 / im.height)
        small = im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))), Image.LANCZOS)
        fish = im.crop(bb)
        k = NORM_H / fish.height
        norm = fish.resize((max(1, int(fish.width * k)), NORM_H), Image.LANCZOS)
        cells.append((tag, small, norm, bb, im.size))

    W = PAD + len(cells) * (COL_W + PAD) + 30 + sum(c[2].width + 24 for c in cells) + PAD
    H = PAD + 24 + 300 + 30 + NORM_H + 40 + PAD
    canvas = Image.new("RGB", (W, H), (255, 255, 255))
    d = ImageDraw.Draw(canvas)

    x0 = PAD
    lx = PAD + len(cells) * (COL_W + PAD) + 30
    d.text((x0, PAD), "① 各尺寸原样（窗口边框=实际窗口矩形，对齐底边）", fill=(28, 34, 48), font=f)
    d.text((lx, PAD), "② 鱼身等高归一化后比宽窄", fill=(28, 34, 48), font=f)
    y = PAD + 24

    for tag, small, norm, bb, size in cells:
        d.rectangle([x0, y, x0 + small.width - 1, y + 299], outline=(226, 230, 238))
        canvas.paste(small, (x0, y + 300 - small.height))
        d.text((x0 + 2, y + 302), "%s  窗口 %dx%d" % (tag, size[0], size[1]), fill=(96, 104, 120), font=f2)
        x0 += COL_W + PAD

    yy = y
    for tag, small, norm, bb, size in cells:
        canvas.paste(norm, (lx, yy))
        d.text((lx + 2, yy + NORM_H + 4), "鱼身 %dx%d" % (bb[2] - bb[0], bb[3] - bb[1]),
               fill=(96, 104, 120), font=f2)
        lx += norm.width + 24

    out = os.path.join(TOOLS, "scale-compare.png")
    canvas.save(out)
    return out


def main():
    if others_running():
        print("失败：已经有 electron.exe 在跑（单实例锁会让本次启动直接退出）")
        return 1

    backup = CONFIG + ".probe-backup"
    shutil.copyfile(CONFIG, backup)
    saved = []
    try:
        for s in SCALES:
            tag = ("%.2f" % s).replace(".", "_")
            print("抓尺寸 %s …" % s)
            if run_one(s, tag):
                saved.append((tag, os.path.join(TOOLS, "scale-%s.png" % tag)))
    finally:
        if not KEEP:
            shutil.copyfile(backup, CONFIG)
        os.remove(backup)

    if len(saved) < 2:
        print("抓到 %d 张，不够拼对照图" % len(saved))
        return 1

    rows = []
    print("\n各尺寸实测（本机 DPI 150%，物理像素 = CSS x1.5）：")
    for tag, path in saved:
        im, bb, bar_top = measure(path)
        fw, fh = bb[2] - bb[0], bb[3] - bb[1]
        rows.append((tag, path, im, bb))
        print("  %-5s 窗口 %4dx%-4d = %3dx%-3d CSS | 鱼 %4dx%-4d = %3dx%-3d CSS"
              " | 鱼宽/窗口宽 %4.1f%% | 长宽比 %.3f | 鱼底到信息条 %.0f CSS"
              % (tag, im.width, im.height, im.width / 1.5, im.height / 1.5,
                 fw, fh, fw / 1.5, fh / 1.5,
                 100.0 * fw / im.width, fh / float(fw), (bar_top - bb[3]) / 1.5))
    print("\n对照图：%s" % compose(rows))
    return 0


if __name__ == "__main__":
    sys.exit(main())
