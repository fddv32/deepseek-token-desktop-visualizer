# -*- coding: utf-8 -*-
"""验收「扣费 -> 受击动画」链路。

做法：启动时设 WHALEPET_FAKE_HIT=3.5（启动 12 秒后伪造一笔 3.5 的扣费），
主进程会在事件时刻抓两帧 —— 0.5s 后应是受击姿态、4.5s 后应回到待机。
抓帧走 win.webContents.capturePage()，拿的是窗口自身像素，不需要算窗口坐标，
也就不会受本机 150% DPI 缩放的影响（抓屏那条路在这里对不准）。

产出：tools/capture-t4000ms.png（常态）/ capture-hit.png / capture-after.png
"""
import json
import os
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

ROOT = r"D:\WhalePet"
EXE = os.path.join(ROOT, "node_modules", "electron", "dist", "electron.exe")
TOOLS = os.path.join(ROOT, "tools")
REPORT = os.path.join(TOOLS, "startup-report.json")

for name in ("config.json",):
    p = os.path.join(ROOT, name)
    if os.path.exists(p):
        os.remove(p)
for name in os.listdir(TOOLS):
    if name.startswith("capture-") and name.endswith(".png"):
        os.remove(os.path.join(TOOLS, name))
if os.path.exists(REPORT):
    os.remove(REPORT)

subprocess.run(["taskkill", "/F", "/IM", "electron.exe"], capture_output=True)
time.sleep(2.0)

env = dict(os.environ)
env.pop("ELECTRON_RUN_AS_NODE", None)
env["WHALEPET_REPORT"] = "1"
env["WHALEPET_CAPTURE"] = "1"
env["WHALEPET_CAPTURE_MS"] = "4000"
env["WHALEPET_FAKE_HIT"] = "3.5"  # >=3 判为 critical，动画最明显

t0 = time.time()
subprocess.Popen(
    [EXE, ROOT], cwd=ROOT, env=env,
    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
)


def steps():
    try:
        with open(REPORT, encoding="utf-8") as fh:
            return json.load(fh).get("steps", [])
    except Exception:
        return []


def saved_names():
    return {s.get("name") for s in steps() if isinstance(s, dict) and s.get("step") == "capture:saved"}


# 等两个关键帧都落盘
want = {"capture-hit.png", "capture-after.png"}
while time.time() - t0 < 45 and not want.issubset(saved_names()):
    time.sleep(0.2)

for name in ("capture-t4000ms.png", "capture-hit.png", "capture-after.png"):
    p = os.path.join(TOOLS, name)
    if os.path.exists(p):
        from PIL import Image
        print("  %-24s %s  %d bytes" % (name, Image.open(p).size, os.path.getsize(p)))
    else:
        print("  %-24s 缺失" % name)

print("--- 启动报告（关键步骤）---")
for s in steps():
    if not isinstance(s, dict):
        continue
    name = str(s.get("step", ""))
    if name.startswith(("usage:", "capture:", "renderer:")) or "fail" in name or "gone" in name:
        print("  ", s)
