# -*- coding: utf-8 -*-
"""生成 Windows 启动脚本（GBK 编码 + CRLF 换行）。

中文 Windows 的 CMD 代码页是 936(GBK)，批处理脚本有两个必须避开的坑：

1. 编码：文件若是 UTF-8，CMD 会按 GBK 逐字节配对，把下一行的首字符吃掉，
   表现为 `'xxd' 不是内部或外部命令` + `系统找不到指定的路径`。
2. 换行：文件若是纯 LF，多行 `if ( ... )` 括号块会解析失效，块内命令会被无条件执行。

另外这里逐字节扫一遍，确认 GBK 双字节汉字的第二字节没有落在
& | < > % ^ 上——这些字节会被 bat 当成控制符，属于隐性炸弹。

用法：python tools/make-launchers.py
"""
import io
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

BAT_LAUNCH = r"""@echo off
chcp 936 >nul 2>&1
cd /d "%~dp0"
setlocal

set "EXE=%~dp0node_modules\electron\dist\electron.exe"
set "APP=%~dp0"

rem %~dp0 always ends with a backslash. Putting it inside quotes escapes the
rem closing quote, so Electron receives a broken path like "D:\WhalePet" and
rem just hangs with a single process and no window. Strip the trailing slash.
if "%APP:~-1%"=="\" set "APP=%APP:~0,-1%"

if not exist "%EXE%" goto needdeps

start "" "%EXE%" "%APP%"
exit /b 0

:needdeps
echo.
echo   [!] 缺少 Electron 运行时，桌宠无法启动。
echo.
echo   解决：双击同目录下的  安装依赖.bat  装一次依赖，
echo         装好之后再双击本文件即可。
echo.
pause
exit /b 1
"""

BAT_DEPS = r"""@echo off
chcp 936 >nul 2>&1
cd /d "%~dp0"
setlocal

set "NPM="

where npm >nul 2>&1
if %errorlevel%==0 set "NPM=npm"

if not defined NPM if exist "%ProgramFiles%\nodejs\npm.cmd" set "NPM=%ProgramFiles%\nodejs\npm.cmd"
if not defined NPM if exist "%ProgramFiles(x86)%\nodejs\npm.cmd" set "NPM=%ProgramFiles(x86)%\nodejs\npm.cmd"
if not defined NPM if exist "%LOCALAPPDATA%\Programs\nodejs\npm.cmd" set "NPM=%LOCALAPPDATA%\Programs\nodejs\npm.cmd"

if not defined NPM goto nonode

echo.
echo   正在安装依赖，首次约 1-3 分钟，请勿关闭本窗口...
echo   使用的 npm: %NPM%
echo.
call "%NPM%" install --registry=https://registry.npmmirror.com --no-audit --no-fund
if errorlevel 1 goto failed

echo.
echo   安装完成。现在可以双击  启动鲸鱼娘桌宠.bat  了。
echo.
pause
exit /b 0

:nonode
echo.
echo   [X] 没有找到 Node.js / npm。
echo.
echo   请先安装 Node.js：打开 https://nodejs.org 下载 LTS 版，
echo   一路下一步装完后，重新双击本文件。
echo.
pause
exit /b 1

:failed
echo.
echo   [X] 安装失败。请确认网络可用后重试。
echo.
pause
exit /b 1
"""

PAIRS = [
    (BAT_LAUNCH, "启动鲸鱼娘桌宠.bat"),
    (BAT_DEPS, "安装依赖.bat"),
]

DANGER = {0x26: "&", 0x7C: "|", 0x3C: "<", 0x3E: ">", 0x25: "%", 0x5E: "^"}


def scan_danger(raw):
    """GBK 双字节字符的第二字节若落在 bat 控制符上，会破坏解析。"""
    problems = []
    i, line = 0, 1
    while i < len(raw):
        b = raw[i]
        if b == 0x0A:
            line += 1
            i += 1
            continue
        if b >= 0x81:
            if i + 1 >= len(raw):
                problems.append((line, "文件以半个汉字结尾"))
                break
            if raw[i + 1] in DANGER:
                problems.append((line, "汉字第二字节是 %r" % DANGER[raw[i + 1]]))
            i += 2
            continue
        i += 1
    return problems


def main():
    rc = 0
    for text, name in PAIRS:
        body = text.replace("\r\n", "\n").replace("\n", "\r\n")
        if not body.endswith("\r\n"):
            body += "\r\n"

        try:
            raw = body.encode("gbk")
        except UnicodeEncodeError as exc:
            print("[FAIL] %s 含有 GBK 无法表示的字符: %s" % (name, exc))
            rc = 1
            continue

        bad = scan_danger(raw)
        if bad:
            for line_no, why in bad:
                print("[FAIL] %s 第 %d 行: %s" % (name, line_no, why))
            rc = 1
            continue

        path = os.path.join(ROOT, name)
        with open(path, "wb") as fh:
            fh.write(raw)

        back = io.open(path, "rb").read()
        assert back == raw, "回读内容不一致"
        crlf = back.count(b"\r\n")
        bare = back.count(b"\n") - crlf
        assert bare == 0, "仍有裸 LF"
        nonascii = sum(1 for x in back if x > 127)
        print(
            "[OK]   %-22s bytes=%-4d CRLF=%-3d 裸LF=%d 非ASCII=%d"
            % (name, len(back), crlf, bare, nonascii)
        )

    return rc


if __name__ == "__main__":
    raise SystemExit(main())
