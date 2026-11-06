@echo off
chcp 65001 >nul
title Valuation Desk
cd /d "%~dp0"

rem If the desk is already running, just open the page instead of starting a second one.
curl.exe -sf --max-time 2 -o NUL http://127.0.0.1:8765/api/health
if not errorlevel 1 (
  echo   Already running - opening browser...
  start "" http://127.0.0.1:8765/
  exit /b 0
)

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Python not found in PATH. Install Python 3 first.
  echo.
  pause
  exit /b 1
)

python server.py
echo.
echo   Server stopped. Press any key to close.
pause >nul