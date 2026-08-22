#!/usr/bin/env bash
# ============================================================
#  ZAO Backend - Alibaba Cloud VM startup script
#
#  Run this to start the Node backend. No local model, no
#  llama-server child process - this just relays
#  /v1/chat/completions to Alibaba Cloud's Model Studio
#  (DashScope) API, which hosts qwen3-coder-30b-a3b-instruct.
#  The VM is 24/7, so once this is running - or better yet,
#  installed as a systemd service (see the bottom of this file)
#  - the phone app just connects straight to the VM's fixed IP.
#  No LAN/tunnel toggle, nothing that rotates.
#
#  FIRST-TIME SETUP (only needed once):
#    1. npm install                     (run in this folder)
#    2. Set DASHSCOPE_API_KEY (env var, or edit config.js) to
#       your Alibaba Cloud Model Studio API key.
#    3. Change AUTH_TOKEN in config.js (or set the ZAO_AUTH_TOKEN
#       env var) to a real secret, then enter that same value in
#       the app's Settings > Server Connection > Model API key
#       field.
#    4. Open the VM's firewall / Alibaba Cloud Security Group for
#       the PORT you're using (8000 by default) so the phone can
#       actually reach it from outside the VM.
#
#  EVERY TIME AFTER THAT: just run ./start.sh - or better, set
#  this up as a systemd service (instructions at the bottom of
#  this file) so it survives VM reboots without you having to
#  SSH in and re-run this manually.
# ============================================================

set -euo pipefail
cd "$(dirname "$0")"

# Everything terminal_pc_run_command and pc_fs_* create (folders,
# scaffolded projects, etc.) is written relative to this root - see
# config.js's PC_BRIDGE_ROOT comment. Defaults to the current user's home
# directory. Override if you'd rather it use a different folder.
export ZAO_PC_BRIDGE_ROOT="${ZAO_PC_BRIDGE_ROOT:-$HOME}"

echo "[ZAO] Starting backend server..."
echo "[ZAO] Listening on 0.0.0.0:${PORT:-8000} - reachable at this VM's public IP."
echo "[ZAO] Enter that IP (and port) in the app's Settings > Server Connection."
echo

exec node index.js

# ------------------------------------------------------------
# OPTIONAL: run as a systemd service instead (recommended for a
# 24/7 VM - survives reboots and SSH disconnects automatically).
# Create /etc/systemd/system/zao-backend.service with:
#
#   [Unit]
#   Description=ZAO Backend
#   After=network.target
#
#   [Service]
#   Type=simple
#   WorkingDirectory=/path/to/this/server/folder
#   ExecStart=/usr/bin/node index.js
#   Environment=ZAO_PC_BRIDGE_ROOT=/root
#   Restart=on-failure
#   User=root
#
#   [Install]
#   WantedBy=multi-user.target
#
# Then:
#   sudo systemctl daemon-reload
#   sudo systemctl enable --now zao-backend
#   sudo journalctl -u zao-backend -f     # tail logs
# ------------------------------------------------------------
