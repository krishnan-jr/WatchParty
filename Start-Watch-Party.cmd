@echo off
setlocal

cd /d "%~dp0"

echo Starting Watch Party...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-share.ps1"

echo.
if errorlevel 1 (
  echo Startup failed. Check the message above.
) else (
  echo Keep this window open while you are sharing.
)

echo.
pause
