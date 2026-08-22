# ZAO Backend (Alibaba Cloud VM edition)

Single model, single user. Runs on a dedicated, always-on Alibaba Cloud VM
instead of on-device or on a person's PC, so the phone app just needs
network access to the VM's fixed public IP. No LAN/tunnel toggle, nothing
that rotates - the VM is 24/7.

## What it is

A small Node/Express server that:
1. Relays chat requests to Alibaba Cloud's Model Studio (DashScope)
   OpenAI-compatible API, which hosts Qwen3-Coder-30B-A3B-Instruct - no
   local model, no GPU/CPU inference on this VM.
2. Exposes an OpenAI-compatible `/v1/chat/completions` endpoint.
3. Exposes `/terminal/run`, which runs real shell commands on this VM -
   auto-detecting bash or a raw Python interpreter per command (see
   `terminal.js`'s `chooseShell()`) - this is what ZAO's Terminal tool
   calls, and the only terminal ZAO has.
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
7. Requires an `Authorization: Bearer <token>` header on every request
   except `/health`, since this server is reachable over the public
   internet at the VM's IP, not just loopback.

You configure the connection once in the app's **Settings > Server
Connection** screen: the VM's IP (or IP:port), tested and saved
independently from the model API key.

## One-time setup (on the VM)

```
cd server
npm install
```

Then set these (env vars, or edit `config.js` directly):

- `DASHSCOPE_API_KEY` - your Alibaba Cloud Model Studio API key (Model
  Studio > API-KEY in the console). Required - the server refuses to
  start without it.
- `DASHSCOPE_BASE_URL` - only if your Model Studio workspace uses a
  different endpoint than the one already set as the default in
  `config.js`.
- `ZAO_AUTH_TOKEN` - **change this from the placeholder** to a real
  secret before exposing this beyond your own machine. Put the same
  value in the app's Settings > Server Connection > Model API key
  field. (This is a different secret from `DASHSCOPE_API_KEY` above -
  `DASHSCOPE_API_KEY` is what this VM sends to Alibaba, `ZAO_AUTH_TOKEN`
  is what the phone sends to this VM.)

Open the VM's firewall / Alibaba Cloud Security Group for whichever port
you're using (`8000` by default) so the phone can actually reach it from
outside the VM.

### OCR (optional, but needed for scanned PDFs / text-in-images)

`/ocr/extract` shells out to Python, not Node, so it needs its own
one-time setup - skip this if you don't need OCR, everything else works
without it:

```
pip install pytesseract pymupdf pillow
```

Plus the Tesseract engine itself (a system binary, not a pip package):

```
sudo apt-get install tesseract-ocr
```

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

Run:

```
./start.sh
```

It prints `ZAO backend listening on 0.0.0.0:<port>` followed by the model
name and Model Studio endpoint it's relaying to - chat requests work
immediately, there's no local model-load wait.

Since the VM is 24/7, you'll want this running as a real background
service rather than tied to an SSH session - `start.sh`'s own header has
a ready-to-use `systemd` unit file for exactly that. Once installed:

```
sudo systemctl enable --now zao-backend
sudo journalctl -u zao-backend -f    # tail logs
```

## Connecting the phone app

Find the VM's public IP (from the Alibaba Cloud console, or `curl
ifconfig.me` on the VM itself) and enter `<that-ip>:8000` as the VM
address in **Settings > Server Connection** - tap **Test & Save**. Then
enter the same value you set for `ZAO_AUTH_TOKEN` as the **Model API
key** and tap its own **Test & Save**. Both checks hit `/health`
directly, so you'll know immediately if either one is wrong.

## Config

Edit `config.js` directly, or set these env vars:

- `DASHSCOPE_API_KEY` - your Alibaba Cloud Model Studio API key (required)
- `DASHSCOPE_BASE_URL` - Model Studio OpenAI-compatible endpoint (defaults
  to this VM's workspace endpoint, already set in `config.js`)
- `ZAO_MODEL_NAME` - model id sent to Model Studio (default
  `qwen3-coder-30b-a3b-instruct`)
- `ZAO_MODEL_TIMEOUT_MS` - max time a Model Studio call can take (default 120000)
- `ZAO_AUTH_TOKEN` - shared secret, must match what's entered in the app
- `ZAO_TERMINAL_CWD` - default working directory for Terminal tool
  commands (default `/root`)
- `ZAO_PYTHON_BIN` - Python command used for OCR (default `python3`) -
  see OCR setup above
- `ZAO_OCR_TIMEOUT_MS` - max time an OCR request can run (default 180000)
- `ZAO_DATA_TIMEOUT_MS` - max time a /data/analyze request can run (default 180000)
- `PORT` - the server's public-facing port (default 8000)
