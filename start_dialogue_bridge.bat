@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "APP_NAME=Yukikaze Live AI"
set "CONTROL_URL=http://127.0.0.1:17374/control"
set "STATUS_URL=http://127.0.0.1:17374/api/status"
set "LOG_DIR=%APPDATA%\YukikazeLiveAI\logs"
set "LAUNCH_LOG=%LOG_DIR%\launcher.log"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { $status = Invoke-RestMethod -Uri '%STATUS_URL%' -TimeoutSec 2; if ($status.ok) { Start-Process '%CONTROL_URL%'; exit 10 } } catch {}; exit 0"

if errorlevel 10 (
  echo %APP_NAME% is already running.
  echo Control: %CONTROL_URL%
  echo.
  pause
  exit /b 0
)

where node.exe >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js 20 or newer was not found in PATH.
  echo Install Node.js, restart the terminal, then run this launcher again.
  echo [%date% %time%] node.exe was not found.>>"%LAUNCH_LOG%"
  echo.
  pause
  exit /b 1
)

where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo ERROR: npm.cmd was not found next to Node.js.
  echo Reinstall Node.js 20 or newer with npm included, then try again.
  echo [%date% %time%] npm.cmd was not found.>>"%LAUNCH_LOG%"
  echo.
  pause
  exit /b 1
)

if not exist "src\server.mjs" (
  echo ERROR: src\server.mjs is missing.
  echo Run this BAT from the complete Yukikaze Live AI project folder.
  echo [%date% %time%] server.mjs is missing from %CD%.>>"%LAUNCH_LOG%"
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\." (
  echo First launch detected. Installing project dependencies...
  call npm.cmd ci
  if errorlevel 1 (
    echo ERROR: Dependency installation failed. Review the npm output above.
    echo [%date% %time%] npm ci failed.>>"%LAUNCH_LOG%"
    echo.
    pause
    exit /b 1
  )
)

echo Starting %APP_NAME%...
echo Control: %CONTROL_URL%
echo Caption source: http://127.0.0.1:17374/caption
echo Dialogue source: http://127.0.0.1:17374/dialogue
echo Keep this window open while using the tool.
echo.

start "" powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass ^
  -File "%~dp0src\open-control-when-ready.ps1" ^
  -ControlUrl "%CONTROL_URL%" ^
  -StatusUrl "%STATUS_URL%" ^
  -LogPath "%LAUNCH_LOG%"

node.exe src\server.mjs
set "EXIT_CODE=%ERRORLEVEL%"

echo.
echo %APP_NAME% stopped with exit code %EXIT_CODE%.
echo Launcher log: %LAUNCH_LOG%
echo.
pause
exit /b %EXIT_CODE%
