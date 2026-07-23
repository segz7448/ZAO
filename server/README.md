# ZAO Backend (PC edition)

Single model, single user. Runs on your Windows PC instead of on-device in
Termux, so the phone app just needs network access to it - over your home
WiFi (LAN mode) or a Cloudflare Quick Tunnel (Remote mode) when you're out.

## What it is

A small Node/Express server that:
1. Spawns `llama-server` (from llama.cpp) as a child process, running
   Qwen2.5-Coder-3B.
2. Exposes an OpenAI-compatible `/v1/chat/completions` endpoint.
3. Exposes `/terminal/run`, which runs real shell commands on this PC -
   auto-detecting cmd.exe, PowerShell, Git Bash, or a raw Python
   interpreter per command (see `terminal.js`'s `chooseShell()`) - this is
   what ZAO's Terminal tool calls, and the only terminal ZAO has.
4. Exposes `/ocr/extract`, which runs free, open-source OCR (Tesseract via
   the `pytesseract` wrapper, with PyMuPDF rendering PDF pages to images
   first) in a Python subprocess - this is what lets ZAO read
   scanned/image-based PDFs and pull text out of attached images (there's
   no vision model, so OCR is the only way image text reaches the model).
5. Exposes `/data/analyze`, which runs pandas (also a Python subprocess)
   against an existing CSV/XLSX file for real data analysis - describe/
   head/filter/groupby - the thing SheetJS (used client-side just to
   *create* spreadsheets) can't do. See `scripts/data_analyze.py`'s
   header for the exact operation shape.
6. Exposes `/preview/start`, `/preview/screenshot`, `/preview/stop`, and
   `/preview/list` (see `devPreview.js`) - starts a dev server (`npm
   start`, `vite`, `python -m http.server`, etc.) as its own tracked
   background process (unlike `/terminal/run`, which runs a command to
   completion/timeout and can't usefully host something that never
   exits), detects its local URL from stdout/stderr, and screenshots the
   rendered page using the same shared Playwright Chromium instance the
   browser agent already runs (see `browserAgent.js`'s `getBrowser()`) -
   closes the loop on "does this actually render right" without you
   checking manually.
7. Restarts `llama-server` automatically if it crashes.
8. Requires an `Authorization: Bearer <token>` header on every request
   except `/health`, since this server is reachable over LAN and the
   public internet (via the tunnel), not just loopback.

Unlike the old Termux setup, there's no fixed URL the app auto-detects -
you configure the connection once in the app's **Settings > Backend
Connection** screen (LAN URL, Remote/tunnel URL, and the auth token).

## One-time setup

```
cd server
npm install
```

Then edit `config.js` (or set the matching env vars) if your model/binary
aren't in `C:\Users\User\Downloads\Model`:

- `MODEL_PATH` - full path to `Qwen2.5-coder-3B-instruct-Q4_K_M.gguf`
- `LLAMA_SERVER_BIN` - full path to `llama-server.exe`
- `ZAO_AUTH_TOKEN` - **change this from the placeholder** to a real secret
  before using Remote mode. Put the same value in the app's Settings.

For Remote mode (Cloudflare Quick Tunnel), get `cloudflared.exe`:

```
winget install --id Cloudflare.cloudflared
```

or download it manually from
https://github.com/cloudflare/cloudflared/releases and place
`cloudflared.exe` on your PATH or directly in this `server/` folder.

### OCR (optional, but needed for scanned PDFs / text-in-images)

`/ocr/extract` shells out to Python, not Node, so it needs its own
one-time setup - skip this if you don't need OCR, everything else works
without it:

```
pip install pytesseract pymupdf pillow
```

Plus the Tesseract engine itself (a system binary, not a pip package):

- Windows: install from https://github.com/UB-Mannheim/tesseract/wiki and
  make sure `tesseract.exe`'s folder is on your PATH.

If you have multiple Python installs, set `PYTHON_BIN` in `config.js` (or
the `ZAO_PYTHON_BIN` env var) to whichever one has the packages above
installed - same "just a PATH command" approach `ZAO_TERMINAL_CWD`'s
Python commands already use.

### Data analysis (optional, needed for analyzing CSV/XLSX files)

`/data/analyze` also shells out to Python (same `PYTHON_BIN`), for real
pandas-based analysis of existing spreadsheets/CSVs - skip this if you
don't need it, everything else works without it:

```
pip install pandas openpyxl
```

No system binary needed beyond Python itself (unlike OCR's Tesseract).

## Every time after that

Double-click `start.bat` (or run it from cmd/PowerShell/Git Bash). It
opens two windows:

- **ZAO Backend** - the Node server + llama-server. Watch for
  `llama-server is ready after N health check(s)` before chatting.
- **ZAO Cloudflare Tunnel** - prints a URL like
  `https://random-words-1234.trycloudflare.com`. This **rotates every
  restart** (it's a free Quick Tunnel, not a permanent named tunnel, which
  would require owning a domain) - copy the fresh URL into the app's
  Settings > Backend Connection > Remote URL field before using Remote
  mode away from home.

Leave both windows running, then open ZAO on your phone.

## LAN mode

Find your PC's local IP (`ipconfig` in cmd, look for IPv4 Address) and
enter `http://<that-ip>:8080` as the LAN URL in Settings. Works as long as
your phone is on the same WiFi as this PC.

## Config

Edit `config.js` directly, or set these env vars:

- `MODEL_PATH` - full path to the GGUF file
- `LLAMA_SERVER_BIN` - full path to `llama-server.exe`
- `LLAMA_THREADS` - CPU thread count (defaults to all logical cores)
- `ZAO_AUTH_TOKEN` - shared secret, must match what's entered in the app
- `ZAO_TERMINAL_CWD` - default working directory for Terminal tool
  commands (default `C:\Users\User`)
- `ZAO_PYTHON_BIN` - Python command used for OCR (default `python`) - see
  OCR setup above
- `ZAO_OCR_TIMEOUT_MS` - max time an OCR request can run (default 180000)
- `ZAO_DATA_TIMEOUT_MS` - max time a /data/analyze request can run (default 180000)
- `PORT` - the server's public-facing port (default 8080)
