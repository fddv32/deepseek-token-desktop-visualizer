@echo off
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
