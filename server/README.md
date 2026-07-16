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

# Use a prebuilt llama.cpp release for Android arm64 (NOT the Ubuntu arm64
# build - that's linked against glibc and won't run under Termux's bionic
# libc, even though the CPU architecture matches). Extract it somewhere in
# Termux, e.g.:
mkdir -p ~/llama-android-arm64
tar -xzf llama-b10037-bin-android-arm64.tar.gz -C ~/llama-android-arm64
chmod +x ~/llama-android-arm64/bin/llama-server

# Put this server/ folder somewhere in Termux, e.g. ~/zao-server
cd ~/zao-server
npm install

# Make sure config.js (or env vars) point at:
#   - LLAMA_SERVER_BIN: ~/llama-android-arm64/bin/llama-server
#   - MODEL_PATH: wherever your Qwen2.5-coder-1.5B-instruct-Q4_K_M.gguf lives
```

Note on binary choice: llama.cpp release tarballs named `...-bin-ubuntu-*`
are built against glibc and Ubuntu's shared libraries - they will fail to
run in Termux (`CANNOT LINK EXECUTABLE`, missing `.so` errors) even on a
matching CPU architecture, because Android uses bionic libc instead of
glibc. Always use the `...-bin-android-*` release for Termux.

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
