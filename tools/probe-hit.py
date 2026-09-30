# -*- coding: utf-8 -*-
"""一次性诊断：飘字到底有没有画到鱼身上。

背景：capture-hit.png 里看不到「-0.3 积分」，但注入的探针显示 DOM 里确实有这些
元素、位置/颜色/透明度都对。这两种情况在**按时间抓的单张截图**里分不清：
  (a) 数字根本没画上去；
  (b) 画上去了，只是抓的那一瞬动画正淡出、或者被鱼的花纹淹掉。

于是 PROBE=2 走另一条路：注入 JS 把动画掐掉、opacity 钉成 1，再抓一张静态帧。
全不透明还是看不到 => (a)；能看到 => (b)，问题只在观感/时机上。

用法：
    python tools/probe-hit.py          # 默认 8 笔
    python tools/probe-hit.py 1        # 单笔（想看清一个数字长什么样时用）

产出：tools/probe-hit-static.png、tools/probe-hit-report.txt（报告里探针那几条）
"""
import json
import os
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

ROOT = r"D:\WhalePet"
REPORT = os.path.join(ROOT, "tools", "startup-report.json")
OUT = os.path.join(ROOT, "tools", "probe-hit-report.txt")
ELECTRON = os.path.join(ROOT, "node_modules", "electron", "dist", "electron.exe")

burst = sys.argv[1] if len(sys.argv) > 1 else "8"

env = dict(os.environ)
env["WHALEPET_REPORT"] = "1"
env["WHALEPET_CAPTURE"] = "1"
env["WHALEPET_PROBE"] = "2"
env["WHALEPET_FAKE_HIT"] = "3.5"
env["WHALEPET_FAKE_BURST"] = burst
env["WHALEPET_FAKE_HIT_AT"] = "6000"

# 和 verify-panel.py 一样：宿主 shell 里可能带 ELECTRON_RUN_AS_NODE=1，
# 那样 electron.exe 会当纯 Node 跑，main.js 第一行就炸、什么都不打印。
env.pop("ELECTRON_RUN_AS_NODE", None)
env.pop("NODE_OPTIONS", None)

subprocess.run(["taskkill", "/F", "/IM", "electron.exe"], capture_output=True)
time.sleep(1.2)

with open(REPORT, "w", encoding="utf-8") as fh:
    fh.write("")

print("启动 electron（PROBE=2，%s 笔）…" % burst)
p = subprocess.Popen([ELECTRON, "."], cwd=ROOT, env=env,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

t0 = time.time()
static_saved = False
while time.time() - t0 < 22:
    time.sleep(0.4)
    try:
        with open(REPORT, "r", encoding="utf-8") as fh:
            d = json.load(fh)
    except Exception:
        continue
    if d.get("pid") != p.pid:
        continue
    for s in d.get("steps", []):
        if isinstance(s, dict) and s.get("step") == "capture:saved" and s.get("name") == "probe-hit-static.png":
            static_saved = True
    if static_saved:
        break

try:
    p.terminate()
except Exception:
    pass
time.sleep(0.8)
subprocess.run(["taskkill", "/F", "/IM", "electron.exe"], capture_output=True)

try:
    with open(REPORT, "r", encoding="utf-8") as fh:
        d = json.load(fh)
except Exception:
    d = {}
keys = ("probe:", "usage:fake-hit", "capture:saved", "renderer:console", "renderer:error")
lines = []
for s in d.get("steps", []):
    txt = json.dumps(s, ensure_ascii=False)
    if any(k in txt for k in keys):
        lines.append(txt)
with open(OUT, "w", encoding="utf-8") as fh:
    fh.write("\n".join(lines))

print("probe-hit-static.png 抓到：" + ("是" if static_saved else "否"))
print("报告片段写到 tools/probe-hit-report.txt（%d 条）" % len(lines))
for ln in lines:
    print("  " + ln)
