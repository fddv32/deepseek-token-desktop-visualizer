@echo off
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
