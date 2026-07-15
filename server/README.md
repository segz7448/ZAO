# ZAO Backend (Termux)

Single model, single user, local only. No Cloudflare tunnel, no external
database, no cloud storage - runs entirely on this device.

## What it is

A small Node/Express server that:
1. Spawns `llama-server` (from llama.cpp) as a child process, running
   Qwen2.5-Coder-3B.
2. Exposes an OpenAI-compatible `/v1/chat/completions` endpoint that the
   ZAO app talks to over `http://127.0.0.1:8080`.
3. Restarts `llama-server` automatically if it crashes.

The app auto-detects this backend at launch - you never type a URL or IP
into the app. You just start this server in Termux before you open ZAO.

## One-time setup

```bash
pkg install nodejs

# Build llama.cpp if you haven't already (produces llama-server binary)
pkg install cmake git
git clone https://github.com/ggml-org/llama.cpp ~/llama.cpp
cd ~/llama.cpp && cmake -B build && cmake --build build --config Release -j4

# Put this server/ folder somewhere in Termux, e.g. ~/zao-server
cd ~/zao-server
npm install

# Make sure config.js (or env vars) point at:
#   - LLAMA_SERVER_BIN: ~/llama.cpp/build/bin/llama-server
#   - MODEL_PATH: wherever your Qwen2.5-coder-3B-instruct-Q4_K_M.gguf lives
```

## Every time after that

```bash
./start.sh
```

Leave that Termux session running, then open ZAO on your phone - it'll
connect automatically. `/health` will show `"status": "ready"` once the
model has finished loading (can take 30-90s on first load).

## Config

Edit `config.js` directly, or set these env vars before running `start.sh`:

- `MODEL_PATH` - full path to the GGUF file
- `LLAMA_SERVER_BIN` - full path to the llama-server binary
- `LLAMA_THREADS` - CPU thread count (default 4)
