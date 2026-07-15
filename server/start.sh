#!/data/data/com.termux/files/usr/bin/bash
# ZAO Backend - launch command
#
# Run this in Termux to start the backend. The ZAO app auto-detects it at
# http://127.0.0.1:8080 - nothing to configure on the phone side.
#
# First-time setup:
#   pkg install nodejs
#   cd ~/zao-server   (wherever you put this server/ folder)
#   npm install
#   Edit config.js (or set MODEL_PATH / LLAMA_SERVER_BIN env vars) to
#   point at your llama-server binary and Qwen2.5-Coder-3B GGUF.
#
# Every time after that, just:
#   ./start.sh

cd "$(dirname "$0")"
node index.js
