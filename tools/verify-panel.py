# -*- coding: utf-8 -*-
"""验收：启动桌宠 → 抓窗口内容 → 打开设置窗口抓图 → 在窗口里真点一遍按钮 → 关掉。

用 win.webContents.capturePage()（应用内自抓）而不是抓屏：
抓屏得自己算窗口坐标，本机 150% DPI 下 GetWindowRect 和实际像素对不上，
而且透明窗口背后的桌面会污染像素统计。capturePage 直接返回窗口像素，与坐标无关。

设置窗口那部分是三段：a 段测外观（大小/形象）并把「手动记账」字段加到信息条上（截图取证），
b 段再摘掉、卸载/安装插件、重载插件，c 段在动作页里挪动作（去掉 / 加回 / 排序 / 试演）。
跑完 usage.json / config.json 会恢复原样。

用法：python tools/verify-panel.py
产出：tools/capture-*.png、settings-window.png、settings-selftest-a/b.png、
     bar-with-manual.png（字段加上后桌宠信息条的实拍）、bar-restored.png、startup-report.json
"""
import json
import os
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

ROOT = r"D:\WhalePet"
REPORT = os.path.join(ROOT, "tools", "startup-report.json")
TOOLS = os.path.join(ROOT, "tools")
USAGE_CFG = os.path.join(ROOT, "usage.json")
CONFIG = os.path.join(ROOT, "config.json")
ELECTRON = os.path.join(ROOT, "node_modules", "electron", "dist", "electron.exe")

# 这两份配置都会被自检改（字段顺序 / 位置 / 信息条高度），先备份、完了还原，
# 这样即使自检中途失败也不会把你的选择改掉。
def _read(path):
    if os.path.exists(path):
        with open(path, "rb") as fh:
            return fh.read()
    return None


usage_backup = _read(USAGE_CFG)
config_backup = _read(CONFIG)

# 刻意**不删任何文件**，全部改成「清空 / 覆盖」：
#   * 报告清空 —— 必须的。报告里留着上一轮的 createWindow:created / capture:saved，
#     验收脚本会立刻把它们当成自己的，拿到过期结果。
#   * config.json 清成 {} —— 等价于没有它（loadConfig 会和默认值合并），
#     这样每次验收都是「干净的一次启动」，位置/信息条高度不残留。
#   * 截图不用管 —— 本轮真正产出了什么，直接从报告里的 capture:saved 读，
#     不靠「先删干净再看剩下的」那套。顺带避免了「删一堆图」这种动作。
with open(REPORT, "w", encoding="utf-8") as fh:
    fh.write("")
with open(CONFIG, "w", encoding="utf-8") as fh:
    fh.write("{}")

env = dict(os.environ)
env["WHALEPET_REPORT"] = "1"
env["WHALEPET_CAPTURE"] = "1"
env["WHALEPET_CAPTURE_MS"] = "4500"
env["WHALEPET_FAKE_HIT"] = "3.5"
# 一次伪造 8 笔（0.1、0.2 … 0.8），模拟「一次日志落盘带回来十几条记录」。
# 这是在验收**逐笔飘字**：抓到的 capture-hit.png 里应当是一串大小不一的数字，
# 而不是一个加起来的合计。把它设成 1 就退回「单笔」的老样子。
env["WHALEPET_FAKE_BURST"] = "8"
env["WHALEPET_FAKE_HIT_AT"] = "9000"
# 不设 WHALEPET_FAKE_LEVEL：一批 8 笔里最重的是 0.8 积分（>= 0.5）= critical 档，
# 所以受击动画照旧验的是「扣费反应」名单里第 3 个动作；而飘字保留各自的大小差异
# （0.1 normal 档 / 0.8 critical 档），截图里一眼能看出「数字是一笔一笔的、轻重不同」，
# 这比全部强制成同一档更有说服力。
env["WHALEPET_OPEN_SETTINGS"] = "1"
env["WHALEPET_PANEL_SELFTEST"] = "1"

# 本次运行的 id。报告是**一个固定文件**，同一台机器上还活着的别的实例也在往里写，
# 后写的整份覆盖先写的 —— 不隔离的话验收会拿到「一半自己的、一半别人的」步骤，
# 表现是「面板自检 a 段跑了两遍」「某张图抓了两次」这种看不懂的重复。
RUN_ID = "%d-%d" % (os.getpid(), int(time.time()))
env["WHALEPET_RUN_ID"] = RUN_ID

# 关键：从某些宿主 shell（包括 WorkBuddy 的 bash）里直接起 electron.exe 时，
# 环境里已经带了 ELECTRON_RUN_AS_NODE=1，electron.exe 会以**纯 Node** 身份运行，
# 于是 main.js 里的 `app` 是 undefined，第 55 行就抛
#   TypeError: Cannot read properties of undefined (reading 'commandLine')
# 而且进程立刻退出、什么都不打印 —— 表现就是「脚本跑完了但一张图都没有」。
# 必须显式摘掉。（.bat 里双击启动没这个问题：Explorer 的环境是干净的。）
env.pop("ELECTRON_RUN_AS_NODE", None)
env.pop("NODE_OPTIONS", None)

# 先把上一轮可能还活着的实例清掉。正常收尾的脚本自己会关（verify-bat.py 现在也会），
# 但手工 Ctrl-C 掉、或上一次崩了都会留下实例 —— 留下来的会跟这一轮抢同一个报告文件
# （固定文件名、整份覆盖），症状是「步骤跑了两遍」这类看不懂的重复。
subprocess.run(["taskkill", "/F", "/IM", "electron.exe"], capture_output=True)
time.sleep(1.2)

print("启动 electron …")
p = subprocess.Popen([ELECTRON, "."], cwd=ROOT, env=env,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def steps():
    """读本轮报告。不是**我拉起来的那个进程**写的一律当空 ——
    报告是个固定文件，别的实例（哪怕是同一个 runId 的第二次启动）会整份覆盖它。"""
    try:
        with open(REPORT, "r", encoding="utf-8") as fh:
            d = json.load(fh)
    except Exception:
        return []
    if d.get("pid") != p.pid:
        return []
    return d.get("steps", [])


def stepname(s):
    """报告里的 step 有两种形态：纯字符串（note('xxx')）和对象（note('xxx', {...})）。"""
    return s if isinstance(s, str) else str(s.get("step", ""))


timeouts = []


def wait_for(pred, timeout, label):
    """轮询启动报告，等到某一步出现。等不到就记一笔 —— 最后要算进退出码。"""
    t0 = time.time()
    while time.time() - t0 < timeout:
        for s in steps():
            if pred(s):
                return s
        time.sleep(0.3)
    print("  !! 超时未等到：" + label)
    timeouts.append(label)
    return None


wait_for(lambda s: stepname(s) == "webContents:did-finish-load", 40, "did-finish-load")
print("页面已加载，等首帧 + 抓图 …")
wait_for(lambda s: stepname(s) == "capture:saved" and isinstance(s, dict) and s.get("name") == "capture-t4500ms.png",
         40, "capture-t4500ms.png")
wait_for(lambda s: stepname(s) == "usage:fake-hit", 30, "usage:fake-hit")
wait_for(lambda s: stepname(s) == "capture:saved" and isinstance(s, dict) and s.get("name") == "capture-hit.png",
         30, "capture-hit.png")
wait_for(lambda s: stepname(s) == "capture:saved" and isinstance(s, dict) and s.get("name") == "capture-after.png",
         30, "capture-after.png")

# 设置窗口（WHALEPET_OPEN_SETTINGS=1 让主进程在 3.5s 时自动开）
print("等设置窗口抓图 …")
wait_for(lambda s: stepname(s) == "settings:auto-open", 30, "settings:auto-open")
wait_for(lambda s: stepname(s) == "capture:saved" and isinstance(s, dict) and s.get("name") == "settings-window.png",
         30, "settings-window.png")

print("等设置窗口点击自检（a / b / c 三段）…")
# 三段是**串起来**跑的（verify-hooks.js 里 a.then(b).then(c)），
# 所以必须等到最后一段的图落盘再收工 —— 早先只等到 b 就 terminate，
# c（动作试演）根本没机会跑，报告里明明没有却看着像「通过」。
for phase in ("a", "b", "c"):
    wait_for(lambda s, p=phase: stepname(s) == "settings:selftest" and isinstance(s, dict) and s.get("phase") == p,
             60, "settings:selftest " + phase)
for shot in ("settings-selftest-a.png", "bar-with-manual.png",
             "settings-selftest-b.png", "bar-restored.png",
             "settings-selftest-c.png", "action-preview.png"):
    wait_for(lambda s, f=shot: stepname(s) == "capture:saved" and isinstance(s, dict) and s.get("name") == f,
             30, shot)

p.terminate()
try:
    p.wait(timeout=10)
except subprocess.TimeoutExpired:
    p.kill()
# terminate 只杀主进程，Electron 的子进程（GPU / renderer / utility）可能留下来；
# 留下来的实例会继续往同一个报告文件里写，把下一轮验收搅乱。
subprocess.run(["taskkill", "/F", "/T", "/PID", str(p.pid)], capture_output=True)
time.sleep(0.6)

# 还原两份配置。原来没有 backup 时是删掉文件 —— 改成写成默认值，
# 少一次删除动作（语义一样：文件里没有键就等于默认）。
if usage_backup is None:
    with open(USAGE_CFG, "w", encoding="utf-8") as fh:
        fh.write(json.dumps({"installed": {}, "fields": ["today", "ctx", "workbuddy", "dsh"]}, indent=2))
else:
    with open(USAGE_CFG, "wb") as fh:
        fh.write(usage_backup)
if config_backup is None:
    with open(CONFIG, "w", encoding="utf-8") as fh:
        fh.write("{}")
else:
    with open(CONFIG, "wb") as fh:
        fh.write(config_backup)
print("usage.json / config.json 已还原")

print()
print("=== 启动报告里值得看的步骤 ===")
for s in steps():
    if isinstance(s, str):
        print("  " + s)
        continue
    k = s.get("step", "")
    if k.startswith(("usage:", "renderer:", "capture:", "webContents:", "boot:", "settings:", "normalizeSize", "skin:")):
        rest = {kk: vv for kk, vv in s.items() if kk != "step"}
        print("  " + k + ("  " + json.dumps(rest, ensure_ascii=False) if rest else ""))

print()
print("=== 设置窗口点击自检 ===")
total = ok = 0
PHASES = ("a", "b", "c")
seen_phases = []
for s in steps():
    if not (isinstance(s, dict) and s.get("step") == "settings:selftest"):
        continue
    seen_phases.append(str(s.get("phase")))
    print("  ── " + str(s.get("phase")) + " 段 ──")
    for r in s.get("results", []):
        total += 1
        good = r.get("ok")
        ok += 1 if good else 0
        print("    %s %s%s" % ("✓" if good else "✗", r.get("step"),
                               ("   " + r["detail"]) if r.get("detail") else ""))
errs = [s for s in steps() if isinstance(s, dict) and s.get("step") == "settings:selftest-error"]
for e in errs:
    print("  !! 自检脚本出错：" + json.dumps(e, ensure_ascii=False))
missing = [p for p in PHASES if p not in seen_phases]
if missing:
    # 「某一段没跑」必须当成失败：否则少跑一段、剩下的全过，看着反而是绿灯
    print("  !! 这几段没跑：%s（报告里只有 %s）" % ("、".join(missing), "、".join(seen_phases) or "无"))
    timeouts.append("selftest phases " + ",".join(missing))
elif len(seen_phases) != len(PHASES):
    # 段数比 3 多 = 这一轮里设置窗口被**重建**过，自检链从头又跑了一遍，
    # 报告里于是混着两条链的步骤（实测出现过 a、b、a、b、c 这种）。
    # 成因是验收期间有人真的在桌面上操作：点/拖桌宠、把设置窗口关掉再打开。
    # 必须当失败 —— 这时「53/53」只是两遍里各挑了一遍的结果，
    # 而你想从这份报告里知道的是「这一轮到底验了什么」。
    print("  !! 自检跑了 %d 段（应为 %d）：%s"
          % (len(seen_phases), len(PHASES), "、".join(seen_phases)))
    print("     多半是验收期间设置窗口被重建了（有人点了桌宠 / 关了又开设置窗口）。关掉手，重跑一次。")
    timeouts.append("selftest phases duplicated")
print("  小计：%d/%d 通过（%d/%d 段）" % (ok, total, len(seen_phases), len(PHASES)))

print()
print("=== 抓到的图 ===")
bad = []
try:
    from PIL import Image  # noqa: E402
except ImportError:
    # PIL 只用来量一下图片尺寸 —— 缺了它不该让整轮验收算失败，
    # 但也不能装作看过了：明确说「没验」并记进 bad。
    Image = None
    bad.append("没装 Pillow，图片只列不验（pip install pillow 后可验证尺寸）")
    print("  ! 没装 Pillow：只列出抓到的图，不验尺寸")

# 只认**本轮报告里记过的** capture:saved —— 不去扫目录「看剩下什么」，
# 那样上一轮遗留的文件会被当成这一轮的成果，明明没抓到也显示通过。
saved = [s for s in steps() if isinstance(s, dict) and s.get("step") == "capture:saved"]
if not saved:
    bad.append("本轮一张图都没抓到")
for s in saved:
    name = str(s.get("name"))
    full = os.path.join(TOOLS, name)
    if Image is None:
        print("  %-28s %.1f KB" % (name, os.path.getsize(full) / 1024 if os.path.exists(full) else -1))
        continue
    try:
        im = Image.open(full)
        im.load()
        print("  %-28s %s  %.1f KB" % (name, im.size, os.path.getsize(full) / 1024))
    except Exception as exc:
        bad.append(name)
        print("  %-28s 打不开：%s" % (name, exc))
if bad:
    print("  缺图 / 坏图：" + "、".join(bad))
empties = [s for s in steps() if isinstance(s, dict) and s.get("step") == "capture:empty"]
for s in empties:
    print("  !! 空图：" + json.dumps(s, ensure_ascii=False))
if timeouts:
    print("  !! 超时的等待：" + "、".join(timeouts))

sys.exit(0 if (total and ok == total and not errs and not bad and not empties and not timeouts) else 1)
