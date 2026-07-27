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
REM  By default this uses a Cloudflare Quick Tunnel, which gets a NEW
REM  random URL every time it starts:
REM    https://random-words-1234.trycloudflare.com
REM  Copy that into the app's Settings > Backend Connection > Remote URL
REM  each time you restart this script.
REM
REM  WANT A URL THAT NEVER CHANGES INSTEAD? Run this once:
REM    node scripts/setup-permanent-tunnel.js
REM  (needs a domain in a Cloudflare account + an API token - the script
REM  explains exactly what to do). Once that's done, start.bat
REM  automatically detects it and uses your permanent URL from then on -
REM  no more copying a new URL in after every restart.
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
    if exist "%~dp0tunnel-config.json" (
        echo [ZAO] Permanent tunnel found - starting named Cloudflare Tunnel...
        for /f "usebackq tokens=* delims=" %%h in (`node -e "console.log(JSON.parse(require('fs').readFileSync('%~dp0tunnel-config.json','utf8')).hostname)"`) do set "ZAO_TUNNEL_HOSTNAME=%%h"
        for /f "usebackq tokens=* delims=" %%n in (`node -e "console.log(JSON.parse(require('fs').readFileSync('%~dp0tunnel-config.json','utf8')).tunnelName)"`) do set "ZAO_TUNNEL_NAME=%%n"
        for /f "usebackq tokens=* delims=" %%c in (`node -e "console.log(JSON.parse(require('fs').readFileSync('%~dp0tunnel-config.json','utf8')).credentialsFile)"`) do set "ZAO_TUNNEL_CREDS=%%c"
        echo [ZAO] Your permanent URL: https://%ZAO_TUNNEL_HOSTNAME%
        echo [ZAO] This does not change - no need to update Settings again.
        start "ZAO Cloudflare Tunnel" cmd /k ""%CLOUDFLARED_CMD%" tunnel --credentials-file "%ZAO_TUNNEL_CREDS%" --url http://localhost:8080 run %ZAO_TUNNEL_NAME%"
    ) else (
        echo [ZAO] Starting Cloudflare Quick Tunnel...
        echo [ZAO] Watch this new window for your remote URL - it looks like:
        echo [ZAO]   https://random-words-1234.trycloudflare.com
        echo [ZAO] Copy that into the app's Settings ^> Backend Connection ^> Remote URL.
        echo [ZAO] Tip: run "node scripts\setup-permanent-tunnel.js" once to get a URL that never changes.
        start "ZAO Cloudflare Tunnel" cmd /k ""%CLOUDFLARED_CMD%" tunnel --url http://localhost:8080"
    )
)

echo.
echo [ZAO] Both windows are launching. This launcher window can be closed -
echo [ZAO] the Backend and Tunnel windows are what keep everything running.
echo.
pause
