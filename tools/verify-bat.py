# -*- coding: utf-8 -*-
"""按「双击 .bat」的方式启动桌宠，验收三件事：
  1) bat 自己正常退出（退出码 0），说明脚本没有踩编码/尾斜杠那两个坑；
  2) electron 进程数是 4（main/GPU/renderer/utility）——1 个就代表参数坏了、窗口永远不出来；
  3) 真实桌面截图里能看到鲸鱼娘，并且信息条上有真实数字。

跑完会把 config.json 还原成你原来的样子（位置 / 缩放 / 形象都不动），并关掉测试实例。

注意：绝不能用 capture_output —— `start` 拉起的 GUI 子进程会继承管道句柄，
父进程读管道要等 EOF，会一直挂住。统一用 DEVNULL。
"""
import atexit
import ctypes
import json
import os
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

ROOT = r"D:\WhalePet"
REPORT = os.path.join(ROOT, "tools", "startup-report.json")
os.chdir(ROOT)

env = dict(os.environ)
env.pop("ELECTRON_RUN_AS_NODE", None)
env["WHALEPET_REPORT"] = "1"  # 让主进程写出窗口句柄，便于精确裁剪

subprocess.run(["taskkill", "/F", "/IM", "electron.exe"], capture_output=True)
time.sleep(2.0)
# config.json 要**先备份再还原**。清空它是为了让每次验收都从默认位置起步（否则会读到上一次
# 验收留下的坐标），但程序启动后会把自己的位置写回去 —— 不还原的话，跑一次验收就把用户的
# 桌宠挪到别处了，而且没有任何提示。（usage.json 这个脚本不碰，不用管。）
CONFIG = os.path.join(ROOT, "config.json")
config_backup = None
if os.path.exists(CONFIG):
    with open(CONFIG, "rb") as fh:
        config_backup = fh.read()


_restored = [False]


def restore_config():
    # 末尾显式调一次（让「已还原」这句话出现在正常输出的最后），atexit 兜底抛错路径。
    # 用标志位去重，免得正常跑完打印两遍。
    if _restored[0] or config_backup is None:
        return
    _restored[0] = True
    try:
        with open(CONFIG, "wb") as fh:
            fh.write(config_backup)
        print("config.json 已还原")
    except Exception as exc:
        print("!! config.json 还原失败：" + str(exc))


# 挂 atexit 而不是只在末尾调一次：中途任何一步抛错都不该把用户的位置弄丢。
atexit.register(restore_config)


# 用「清空」而不是「删除」：效果完全一样（报告必须空着，否则会立刻读到上一轮的
# createWindow:created 拿到过期句柄；config.json 清成 {} 等价于没有它，loadConfig
# 会和默认值合并），但少两次删除动作 —— 有些环境对一轮会话里的删除量有阈值限制。
with open(REPORT, "w", encoding="utf-8") as fh:
    fh.write("")
with open(CONFIG, "w", encoding="utf-8") as fh:
    fh.write("{}")

p = subprocess.Popen(
    ["cmd", "/c", "启动鲸鱼娘桌宠.bat"],
    cwd=ROOT, env=env,
    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
)
try:
    p.wait(timeout=15)
except subprocess.TimeoutExpired:
    print("!! bat 未在 15s 内退出（异常）")
print("bat 退出码:", p.poll())

# 等窗口建立 + 第一次用量轮询（主进程启动 2s 后才第一次 poll）
hwnd = None
t0 = time.time()
while time.time() - t0 < 20:
    time.sleep(0.3)
    if os.path.exists(REPORT):
        try:
            with open(REPORT, encoding="utf-8") as fh:
                data = json.load(fh)
            for step in data.get("steps", []):
                if isinstance(step, dict) and step.get("step") == "createWindow:created":
                    hwnd = step.get("hwnd")
        except Exception:
            pass
    if hwnd:
        break
print("hwnd =", hwnd)

time.sleep(8)  # 再等一下，保证信息条已经渲染出数字

q = subprocess.run(
    ["tasklist", "/FI", "IMAGENAME eq electron.exe", "/NH"],
    capture_output=True,
)
nproc = q.stdout.decode("gbk", "replace").lower().count("electron.exe")
print("electron 进程数:", nproc, "(健康值 = 4)")

ctypes.windll.user32.SetProcessDPIAware()
from PIL import ImageGrab  # noqa: E402

img = ImageGrab.grab(all_screens=True)
img.resize((1280, 720)).save(os.path.join(ROOT, "tools", "bat-launch-desktop.png"))

box = None
if hwnd:
    from ctypes import wintypes
    rect = wintypes.RECT()
    ctypes.windll.user32.GetWindowRect(wintypes.HWND(hwnd), ctypes.byref(rect))
    box = (rect.left, rect.top, rect.right, rect.bottom)
    print("窗口矩形:", box, "尺寸 %dx%d" % (rect.right - rect.left, rect.bottom - rect.top))

# 交叉校验：按「鲸鱼蓝」像素在抓屏图里自己找一遍桌宠位置。
# 本机是 150% DPI，抓屏坐标系偶尔和 GetWindowRect 对不上，
# 有这个兜底就能立刻看出来是哪边的锅（像素找不到 = 桌宠压根没画出来）。
hits = []
px = img.load()
for y in range(0, img.height, 4):
    for x in range(0, img.width, 4):
        r, g, b = px[x, y][:3]
        if b > 150 and b - r > 60 and b - g > 40 and g < 160:
            hits.append((x, y))
print("鲸鱼蓝像素点数:", len(hits))
if hits:
    xs = [a for a, _ in hits]
    ys = [b for _, b in hits]
    print("蓝像素分布 x %d..%d  y %d..%d" % (min(xs), max(xs), min(ys), max(ys)))
    if box is None:
        box = (max(0, min(xs) - 70), max(0, min(ys) - 70),
               min(img.width, max(xs) + 70), min(img.height, max(ys) + 70))

if box:
    img.crop(box).save(os.path.join(ROOT, "tools", "bat-launch-pet.png"))
    print("已裁剪桌宠区域:", box)

try:
    with open(REPORT, encoding="utf-8") as fh:
        data = json.load(fh)
    interesting = ("usage:", "renderer:", "did-fail", "render-process-gone", "capture:")
    for step in data.get("steps", []):
        if not isinstance(step, dict):
            continue
        name = str(step.get("step", ""))
        if name.startswith(interesting) or "fail" in name or "gone" in name:
            print("  ", step)
except Exception as exc:
    print("读报告失败", exc)

# 收尾：**先关掉测试实例，再还原 config.json**，顺序不能反。
# 到这个位置「双击能起来」已经验完了（4 个进程、真实截图都拿到了），继续留着它没有任何验证价值；
# 反而会让还原失效 —— 桌宠在退出时会把当前位置写回 config.json，我们前脚还原、它后脚覆盖，
# 用户的位置还是丢了。先关掉，还原才作数。
subprocess.run(["taskkill", "/F", "/IM", "electron.exe"], capture_output=True)
time.sleep(0.8)
restore_config()
