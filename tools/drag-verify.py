# 桌宠交互验收器（诊断用）
#
# 一个进程内完成：干净启动 -> 从启动报告拿原生句柄 -> 校验命中点 -> 真实鼠标操作 ->
# 抓真实桌面（每张都同时记录「按下快门那一刻」的窗口矩形，方便精确裁剪）-> 杀进程。
#
# 用法：
#   python drag-verify.py <mode:system|poll> [poll_ms] [步数] [每步像素]

import ctypes
import json
import os
import subprocess
import sys
import time
from ctypes import wintypes

from PIL import ImageGrab

ROOT = "D:/WhalePet"
EXE = os.path.join(ROOT, "node_modules", "electron", "dist", "electron.exe")
REPORT = os.path.join(ROOT, "tools", "startup-report.json")
OUT = os.path.join(ROOT, "tools", "ab")

user32 = ctypes.windll.user32
user32.SetProcessDPIAware()

MODE = sys.argv[1] if len(sys.argv) > 1 else "poll"
POLL_MS = sys.argv[2] if len(sys.argv) > 2 else "16"
STEPS = int(sys.argv[3]) if len(sys.argv) > 3 else 24
STEP_PX = int(sys.argv[4]) if len(sys.argv) > 4 else 9

SHOTS = []


def kill_all():
    """杀掉所有 electron。必须确认真的杀干净了：程序带单实例锁，
    残留实例会让本次 launch 直接退出，而验收脚本会去读上一轮的陈旧报告、
    量到别人家的窗口——这类假数据比没数据更坏。"""
    for _ in range(3):
        subprocess.run(["taskkill", "/F", "/T", "/IM", "electron.exe"], capture_output=True)
        time.sleep(0.8)
        left = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq electron.exe", "/NH"],
            capture_output=True, text=True, errors="replace",
        ).stdout
        if "electron.exe" not in left.lower():
            return True
    return False


def reset_config():
    cfg = {"x": 600, "y": 300, "scale": 1, "alwaysOnTop": True}
    with open(os.path.join(ROOT, "config.json"), "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, indent=2)


def launch():
    env = dict(os.environ)
    env.pop("ELECTRON_RUN_AS_NODE", None)
    env["WHALEPET_REPORT"] = "1"
    env["WHALEPET_DRAG_MODE"] = MODE
    env["WHALEPET_POLL_MS"] = POLL_MS
    log = open(os.path.join(ROOT, "tools", "pet-run.log"), "w")
    # 不传任何命令行开关：沙箱/硬件加速由 main.js 自己兜底，
    # 这样验收的就是用户双击时真正跑的那条路径。
    return subprocess.Popen(
        [EXE, ROOT],
        env=env, stdout=log, stderr=subprocess.STDOUT,
    )


def wait_hwnd(timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            data = json.load(open(REPORT, encoding="utf-8"))
        except Exception:
            time.sleep(0.3)
            continue
        for step in reversed(data.get("steps", [])):
            if isinstance(step, dict) and step.get("step") == "createWindow:created":
                hwnd = int(step["hwnd"])
                if user32.IsWindow(hwnd):
                    return hwnd
        time.sleep(0.3)
    return None


def rect_of(hwnd):
    r = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    return [r.left, r.top, r.right - r.left, r.bottom - r.top]


def find_hit(hwnd):
    """透明窗口只对不透明像素命中；Chromium 内容在子窗口里，所以比对根窗口。"""
    l, t, w, h = rect_of(hwnd)
    for yy in range(t + h - 60, t + 8, -14):
        for xx in range(l + w // 2 - 110, l + w // 2 + 111, 14):
            found = user32.WindowFromPoint(wintypes.POINT(xx, yy))
            if found and user32.GetAncestor(found, 2) == hwnd:
                return xx, yy
    return None


def get_cursor():
    p = wintypes.POINT()
    user32.GetCursorPos(ctypes.byref(p))
    return p.x, p.y


def set_cursor(x, y, tol=3):
    """移动光标并回读确认。某些受限会话里 SetCursorPos 会静默失败，
    那时后续的点击/拖动全部落在别的地方，量出来的数据是假的——必须先挡住。"""
    user32.SetCursorPos(int(x), int(y))
    time.sleep(0.05)
    cx, cy = get_cursor()
    return abs(cx - x) <= tol and abs(cy - y) <= tol


def snap(hwnd, name):
    rect = rect_of(hwnd)
    path = os.path.join(OUT, name + ".png")
    ImageGrab.grab(all_screens=True).save(path)
    SHOTS.append({"name": name, "rect": rect, "file": path})
    return rect


def crop(rect, margin=30):
    l, t, w, h = rect
    return (max(0, l - margin), max(0, t - margin), min(2560, l + w + margin), min(1440, t + h + margin))


def main():
    os.makedirs(OUT, exist_ok=True)
    tag = MODE if MODE == "system" else "poll%s" % POLL_MS
    result = {"mode": MODE, "pollMs": POLL_MS}

    if not kill_all():
        print(json.dumps({"error": "还有 electron 残留进程，无法保证测的是本次启动的窗口"}, ensure_ascii=False))
        return 3
    reset_config()
    # 启动前把报告清掉：wait_hwnd 只认本次启动写出来的句柄，避免量到上一轮的窗口
    try:
        os.remove(REPORT)
    except OSError:
        pass
    launch()
    hwnd = wait_hwnd()
    if not hwnd:
        print(json.dumps({"error": "拿不到有效窗口句柄"}, ensure_ascii=False))
        kill_all()
        return 1
    result["hwnd"] = hwnd

    time.sleep(3.0)  # 等网页加载完、监听挂上

    start = rect_of(hwnd)
    hit = None
    for _ in range(20):
        hit = find_hit(hwnd)
        if hit:
            break
        time.sleep(0.5)
    result["startRect"] = start
    result["hitPoint"] = hit
    if not hit:
        print(json.dumps({"error": "扫不到可命中像素"}, ensure_ascii=False))
        kill_all()
        return 2

    sw = user32.GetSystemMetrics(0)
    steps = max(6, min(STEPS, max(0, (sw - 20 - (start[0] + start[2] + STEP_PX)) // STEP_PX)))
    result["stepsUsed"] = steps

    snap(hwnd, "1-%s-idle" % tag)

    # ---- 单击：原地按下抬起 ----
    px, py = hit
    if not set_cursor(px, py):
        print(json.dumps({
            "error": "SetCursorPos 未生效，光标实际在 %s，本次测量无效" % (get_cursor(),),
        }, ensure_ascii=False))
        kill_all()
        return 4
    time.sleep(0.2)
    user32.mouse_event(0x0002, 0, 0, 0, 0)
    time.sleep(0.08)
    user32.mouse_event(0x0004, 0, 0, 0, 0)
    time.sleep(0.45)
    snap(hwnd, "2-%s-click" % tag)

    # ---- 拖动：按住横移，途中连续抓屏 ----
    time.sleep(0.9)
    px, py = find_hit(hwnd) or hit
    if not set_cursor(px, py):
        print(json.dumps({
            "error": "SetCursorPos 未生效，光标实际在 %s，本次测量无效" % (get_cursor(),),
        }, ensure_ascii=False))
        kill_all()
        return 4
    time.sleep(0.25)
    # 基准点必须取「真正按下的这一刻」：上面的 find_hit 可能和上一次返回不同的像素，
    # 而窗口位移是相对按下瞬间的光标位置算的，拿最初的 hit 当基准会凭空多出一段差值。
    drag_from = rect_of(hwnd)
    result["dragFromCursor"] = [px, py]
    result["dragFromRect"] = drag_from
    user32.mouse_event(0x0002, 0, 0, 0, 0)
    time.sleep(0.2)
    for i in range(1, steps + 1):
        set_cursor(px + i * STEP_PX, py - i * 3)
        time.sleep(0.016)
        if i == max(1, steps // 2):
            snap(hwnd, "3-%s-drag-mid" % tag)
    snap(hwnd, "4-%s-held" % tag)
    user32.mouse_event(0x0004, 0, 0, 0, 0)
    time.sleep(0.5)
    snap(hwnd, "5-%s-released" % tag)

    end = rect_of(hwnd)
    result["endRect"] = end
    result["moved"] = [end[0] - drag_from[0], end[1] - drag_from[1]]
    result["expectedMoved"] = [steps * STEP_PX, -steps * 3]
    result["shots"] = SHOTS

    try:
        data = json.load(open(REPORT, encoding="utf-8"))
        result["appSteps"] = [s.get("step") if isinstance(s, dict) else s for s in data.get("steps", [])]
    except Exception:
        pass

    kill_all()
    with open(os.path.join(OUT, "result-%s.json" % tag), "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=2)
    print(json.dumps({k: v for k, v in result.items() if k != "shots"}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
