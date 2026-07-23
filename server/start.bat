@echo off
REM ============================================================
REM  ZAO Backend - PC startup script
REM
REM  Double-click this file (or run it from cmd/PowerShell/Git
REM  Bash) to start everything: the Node backend + llama-server,
REM  plus a Cloudflare Quick Tunnel so the phone app can reach
REM  this PC from outside your home WiFi.
REM
REM  FIRST-TIME SETUP (only needed once):
REM    1. npm install          (run in this folder)
REM    2. Get cloudflared.exe - easiest way:
REM         winget install --id Cloudflare.cloudflared
REM       or download manually from:
REM         https://github.com/cloudflare/cloudflared/releases
REM       and put cloudflared.exe on your PATH, or in this same
REM       folder.
REM    3. Edit config.js if your model/llama-server.exe aren't in
REM       C:\Users\User\Downloads\Model
REM    4. Change AUTH_TOKEN in config.js (or set the ZAO_AUTH_TOKEN
REM       env var) to a real secret, then enter that same value in
REM       the app's Settings > Backend Connection screen.
REM
REM  EVERY TIME AFTER THAT: just double-click start.bat.
REM
REM  When this window shows a line like:
REM    https://random-words-1234.trycloudflare.com
REM  that's your rotating remote URL - copy it into the app's
REM  Settings > Backend Connection > Remote URL field. It changes
REM  every time you restart this script, so you'll need to update
REM  it in the app each time you're about to leave home WiFi.
REM ============================================================

setlocal

cd /d "%~dp0"

REM Everything terminal_pc_run_command and pc_fs_* create (folders,
REM scaffolded projects, etc.) is written relative to this root - see
REM config.js's PC_BRIDGE_ROOT comment. Set to Downloads so anything ZAO
REM creates shows up where you're actually looking for it. Change this
REM path if you'd rather it use a different folder.
if not defined ZAO_PC_BRIDGE_ROOT set "ZAO_PC_BRIDGE_ROOT=%USERPROFILE%\Downloads"

where cloudflared >nul 2>nul
if %errorlevel% neq 0 (
    if exist "%~dp0cloudflared.exe" (
        set "CLOUDFLARED_CMD=%~dp0cloudflared.exe"
    ) else (
        echo.
        echo [ZAO] cloudflared.exe was not found on PATH or in this folder.
        echo [ZAO] Install it with:  winget install --id Cloudflare.cloudflared
        echo [ZAO] or download it from:
        echo [ZAO]   https://github.com/cloudflare/cloudflared/releases
        echo [ZAO] and place cloudflared.exe in this folder, then re-run start.bat.
        echo.
        echo [ZAO] Starting backend WITHOUT a tunnel - LAN mode will still work.
        echo.
        set "SKIP_TUNNEL=1"
    )
) else (
    set "CLOUDFLARED_CMD=cloudflared"
)

echo [ZAO] Starting backend server...
start "ZAO Backend" cmd /k "cd /d "%~dp0" && node index.js"

REM Give the Node server a moment to bind its port before the tunnel
REM tries to point at it.
timeout /t 3 /nobreak >nul

if not defined SKIP_TUNNEL (
    echo [ZAO] Starting Cloudflare Quick Tunnel...
    echo [ZAO] Watch this new window for your remote URL - it looks like:
    echo [ZAO]   https://random-words-1234.trycloudflare.com
    echo [ZAO] Copy that into the app's Settings ^> Backend Connection ^> Remote URL.
    start "ZAO Cloudflare Tunnel" cmd /k ""%CLOUDFLARED_CMD%" tunnel --url http://localhost:8080"
)

echo.
echo [ZAO] Both windows are launching. This launcher window can be closed -
echo [ZAO] the Backend and Tunnel windows are what keep everything running.
echo.
pause
