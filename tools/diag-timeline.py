# -*- coding: utf-8 -*-
"""时间线实验：Electron 到底是没起来，还是起来后被干掉。

用真实 .bat（和双击同一条路径）启动，每 1.5 秒采一次进程数。
"""
import os
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

ROOT = r"D:\WhalePet"
EXE = os.path.join(ROOT, "node_modules", "electron", "dist", "electron.exe")
env = dict(os.environ)
env.pop("ELECTRON_RUN_AS_NODE", None)


def n():
    q = subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq electron.exe", "/NH"],
        capture_output=True,
    )
    return q.stdout.decode("gbk", "replace").lower().count("electron.exe")


def kill():
    subprocess.run(["taskkill", "/F", "/IM", "electron.exe"], capture_output=True)
    time.sleep(1.8)


def watch(label, popen):
    print("--- %s ---" % label)
    for i in range(8):
        time.sleep(1.5)
        alive = n()
        print("  t=%4.1fs  父进程=%s  electron=%d" % ((i + 1) * 1.5, popen.poll(), alive))
        if alive and i >= 2:
            break


kill()
cfg = os.path.join(ROOT, "config.json")
if os.path.exists(cfg):
    os.remove(cfg)

p1 = subprocess.Popen(
    ["cmd", "/c", "启动鲸鱼娘桌宠.bat"], cwd=ROOT, env=env,
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
)
watch("真实 bat（cmd /c 启动脚本）", p1)
print("  bat 退出码:", p1.poll())
print("  config.json 已生成:", os.path.exists(cfg))
kill()

time.sleep(0.5)
p2 = subprocess.Popen([EXE, ROOT], cwd=ROOT, env=env,
                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
watch("对照组：直接启动 exe", p2)
print("  exe 是否仍在跑:", p2.poll() is None)
kill()
print("已清理")
