# ZAO

An Android chat app whose "brain" runs on your PC, not the phone or the
cloud. One model - **Qwen2.5 Coder 3B**, served by a small Node backend on
your PC (`/server`) via `llama-server` (llama.cpp) - handles chat, coding,
reasoning, and tool-calling. The phone talks to it over LAN or a
Cloudflare Quick Tunnel. Beyond chat, ZAO acts as an on-device agent: it
can browse the web (via a Playwright agent also running on the PC), push
code to GitHub, run real shell commands on the PC, and create/read PDF/Word/Excel/PowerPoint files
- all invoked automatically by the model deciding what a request needs,
not through dedicated buttons.

**No vision, no audio, no image generation.** There is exactly one model
and it's text-only. Attached images still show up as chat bubbles, but
the model can't see them - only whatever text OCR pulls out of them (see
"File handling" below). There's no speech-to-text, no text-to-speech, no
voice mode, and no image generation anywhere in the app.

## The model

| Model | Where it runs | Used for |
|---|---|---|
| **Qwen2.5 Coder 3B Instruct** (Q4_K_M GGUF) | Your PC, via `llama-server` | Everything: chat, coding, reasoning, tool-calling/routing |

That's it - one model, no fallback chain, no task-based switching, no
on-device weights on the phone. `src/config/localModels.js` keeps a single
`MODEL_KEYS.QWEN25_CODER_3B` key purely so call sites that predate this
(`toolOrchestrator.js`, `memoryEngine.js`) didn't need rewriting - the key
itself is cosmetic; the backend only ever runs whatever `MODEL_PATH` in
`server/config.js` points to.

## Architecture

```
App.js                         Screen state machine (chat/settings/plan/browserAgent),
                              mounts the persistent BrowserAgentPiP + BrowserAgentStream
                              connection, wires PlanScreen to planStore's actions.

src/
  db/database.js               SQLite layer. Every function returns {success, data, error},
                              never throws. Source of truth for conversations, messages,
                              preferences, memories, procedures, plans, usage log.
  config/localModels.js        The one model key + classifyTask(), a keyword-based
                              degraded fallback used only when the model-based
                              classifier (intentClassifier.js) can't be reached.
  services/
    backend/backendClient.js    Talks to the PC backend: sendMessage() (chat completions),
                              runTerminalCommand() (PC terminal), runOcrExtraction()
                              (OCR). Handles LAN vs. Remote (tunnel) connection modes
                              and the shared-secret auth token.
    intentClassifier.js         Model-based router: classifies a message into
                              github / browsing / general.
    toolOrchestrator.js          Flat ReAct-style tool-calling loop: GitHub, filesystem,
                              terminal, PDF, and Office (docx/xlsx/pptx/csv-create)
                              tools, driven by real OpenAI-style tool_calls.
    github/githubTool.js          Real GitHub REST/Git Data API calls (create repo,
                              read/commit files, branches, PRs, releases) using the
                              person's own Personal Access Token.
    filesystem/filesystemTool.js  Device-wide file ops (create/move/rename/delete/zip/
                              extract) under a folder granted once via Android's
                              Storage Access Framework.
    terminal/
      pcTerminalTool.js           The full terminal, and the only one ZAO
                                has - runs on the PC via the backend's
                                /terminal/run.
      terminalRouter.js            Gives the model live PC-reachability/internet
                                status.
      commandSafety.js             Hard-blocks catastrophic commands (rm -rf /, mkfs,
                                fork bombs); gates destructive-but-legitimate ones
                                (rm -rf, git push --force, DROP TABLE) behind an
                                explicit confirmed:true the app doesn't set yet.
    pdf/pdfTool.js                 Create/merge/split PDFs (pdf-lib).
    office/{docxTool,xlsxTool,pptxTool}.js  Create Word/Excel/PowerPoint files.
    brain/
      frontendBrain.js             decideRoute(): combines intentClassifier.js with
                                the free local shouldDecompose() heuristic to pick
                                one of HIERARCHICAL_PLAN / TOOL_TASK / BROWSING / CHAT.
      backendBrain.js              BRAIN_ROLES taxonomy + runHierarchicalPlan(),
                                which drives planCoordinator/planExecutor for goals
                                big enough to decompose.
    reasoning/                    Chain-of-thought (default), tree-of-thought,
                              self-reflection, deductive/inductive/abductive/
                              analogical inference - see REASONING_ARCHITECTURE.md.
    planning/                    8-module Strategic -> Project -> Task -> Execution
                              planning system - see BRAIN_ARCHITECTURE.md.
    memory/                      Working-memory compaction, semantic facts, procedural
                              memory, lexical retrieval - see MEMORY_ARCHITECTURE.md.
    browserAgent/                 Phone-side display/control for the PC-hosted
                              Playwright browser agent (see server/browserAgent.js) -
                              a WebSocket stream, not an on-device browser.
    fileProcessor.js             Entry point for any attached file - routes to the
                              right extractor, normalizes every result into one
                              shape, falls back to server-side OCR when local PDF
                              text extraction finds nothing.
    textExtraction.js /
    zipHandler.js                 On-device plain text/CSV extraction and ZIP
                              unzipping (expo-file-system + papaparse / jszip).
  files/
    pdfExtractor.js               On-device, pattern-matching PDF text extraction -
                              works on normal text-based PDFs; scanned/image-based
                              PDFs fall through to fileProcessor.js's OCR fallback.
    officeExtractors.js            On-device .docx text extraction (jszip).
  utils/orchestrator.js           The one function the UI calls to send a message:
                              frontendBrain.decideRoute() picks a path, then either
                              runs reasoningEngine's runReasoningChat() (plain chat),
                              toolOrchestrator (tool task), the browser agent, or
                              backendBrain.runHierarchicalPlan(). Never throws.
  store/
    chatStore.js                   Zustand store: messages, conversations, sending
                                state, attachment extraction, assembleHistory()
                                (semantic facts -> retrieved snippets -> rolling
                                summary -> raw recent turns, in that order).
    planStore.js                    Wraps the planning system for PlanScreen.js.
    preferencesStore.js              Theme, memory/browser-access toggles, backend
                                connection settings, GitHub token status.
  screens/
    ChatScreen.js                    Main chat UI, ReasoningChip, "View Plan" chip.
    PlanScreen.js / StepDetailSheet.js  Approve/reject steps, milestone strip,
                                checkpoint bar, four-tier trace drill-down.
    SettingsScreen.js                 Backend Connection, GitHub token, Memory,
                                Browser Agent, Usage.
    BrowserAgentScreen.js             Full-screen live browser agent view.
  components/                     ErrorBoundary, SidebarDrawer, AttachmentSheet,
                              MarkdownText, MessageActionMenu/Actions, Toast,
                              ImageViewerModal.
  theme/                        tokens.js (light+dark palettes) + useTheme.js.

server/                        PC backend (Node/Express) - see server/README.md.
  index.js                       Spawns/monitors llama-server, proxies
                              /v1/chat/completions, health check + internet-
                              reachability self-check, rate limiting, auth.
  terminal.js                    /terminal/run - real cmd.exe execution.
  ocr.js + scripts/ocr_extract.py  /ocr/extract - free, open-source OCR
                              (Tesseract via pytesseract, PyMuPDF for PDF page
                              rendering) in a Python subprocess.
  browserAgent.js / browserStream.js  Playwright-driven browser agent + its
                              WebSocket stream to the phone, including a
                              needsHuman handoff for CAPTCHAs/2FA.
```

For the deeper architectural picture (what "brain," "reasoning," and
"memory" mean here and exactly what's wired vs. still a gap), see:

- `BRAIN_ARCHITECTURE.md` - dense/MoE/multi-brain/hybrid-symbolic taxonomy
  and which files implement which.
- `REASONING_ARCHITECTURE.md` - CoT/ToT/ReAct/self-reflection/inference-mode
  taxonomy and routing.
- `MEMORY_ARCHITECTURE.md` - working/episodic/semantic/procedural/retrieval
  memory taxonomy and routing.
- `SYSTEM_COMPONENTS.md` - routing, state management, feedback loop,
  human-in-the-loop, and audit trail: what exists, what doesn't.
- `HARDENING_NOTES.md` - security/reliability gaps and what's fixed.

## Setup

**PC backend** (does the actual model inference - see `server/README.md`
for full detail):
```
cd server
npm install
# edit config.js: MODEL_PATH, LLAMA_SERVER_BIN, ZAO_AUTH_TOKEN
```
Double-click `start.bat` (or run it from a shell) each time before using
the app - it starts the Node server + `llama-server`, and optionally a
Cloudflare Quick Tunnel for Remote mode.

**Phone app**:
```bash
npm install
npx expo start          # dev server, scan QR with Expo Go for quick iteration
npx expo prebuild --platform android --clean   # generate native android/ project
```
Then in **Settings > Backend Connection**, enter the PC's LAN URL (or the
tunnel URL for Remote mode) and the same auth token set in
`server/config.js`.

## Tool access (GitHub, filesystem, terminal)

None of these have dedicated buttons - ask in plain language, and
`toolOrchestrator.js` (driven by the model) decides which tool(s) to call
and shows a running checklist as it works.

- **GitHub** - add a Personal Access Token with `repo` scope in
  **Settings**. Uses the REST/Git Data API (blob -> tree -> commit ->
  update ref) since there's no `git` binary in the RN runtime.
- **Filesystem** - grant a folder once via Android's system folder picker,
  then the model can create/move/rename/delete/zip/extract files in it.
  Every `.js`/`.jsx`/`.ts`/`.tsx`/`.json` write is syntax/JSX-checked with
  a real parser (`syntaxCheck.js`) before it touches disk - a broken file
  is refused instead of saved. `fs_check_syntax`/`fs_check_project_syntax`
  check on demand; the same project-wide check also runs automatically
  right before a terminal command that starts/builds a project
  (`projectRunGate.js`), blocking the run if anything fails.
- **Terminal** - the PC backend (`terminal_pc_run_command`, the only
  terminal ZAO has - see `terminalRouter.js`) auto-detects cmd.exe,
  PowerShell, Git Bash, or a raw Python interpreter per command, so
  `zip`/`unzip`/`tar` just work as plain
  commands with no special-casing needed - in addition to the JS-level
  zip handling already in `zipHandler.js` (for reading an uploaded zip
  attachment) and `filesystemTool.js` (`fs_zip`/`fs_extract_zip`, for the
  model creating/extracting archives as part of a task).

## Browser agent

The composer's globe icon toggles live web browsing. The browser itself
runs on the PC via Playwright (`server/browserAgent.js`), streamed live to
the phone over a WebSocket (`src/services/browserAgent/browserAgentStream.js`)
- `BrowserAgentPiP.js`/`BrowserStreamView.js` render the live screenshot
feed and let the person take over manually (CAPTCHAs, logins, 2FA) when
the agent flags `needsHuman`. One `BrowserAgentStream` connection persists
for the app's lifetime so a session's page/history survives across
separate tasks in the same conversation.

## File handling

ZAO can read PDF, Word (.docx), ZIP archives, CSV, plain text/code files,
and images attached via the "+" button - and separately, create new PDF/
Word/Excel/PowerPoint/CSV files on request via the tool-calling path.

- **CSV, plain text/code files** - extracted entirely on-device
  (`textExtraction.js`) via `expo-file-system` + `papaparse`.
- **ZIP archives** - unzipped entirely on-device (`jszip`, pure JS), capped
  at 30 entries / ~60,000 combined characters so a huge archive can't hang
  the app or blow out the model's context window.
- **PDF** - `src/files/pdfExtractor.js` does on-device, pattern-matching
  text extraction first (fast, no network, works on normal text-based
  PDFs). When that finds nothing or flags a suspiciously low text-to-size
  ratio (likely scanned/image-based), `fileProcessor.js` falls back to
  real OCR on the PC backend (`server/ocr.js` - free, open-source
  Tesseract + PyMuPDF, no cloud call).
- **Word (.docx)** - on-device extraction (`officeExtractors.js`, jszip).
- **.pptx reading** - not supported yet (creating a .pptx works; reading
  one back would need dedicated slide-XML parsing that hasn't been built).
- **Images** - there's no vision model, so the model can't see an attached
  image. It still attaches and displays as a chat bubble, and
  `fileProcessor.js` runs the same OCR path against it as a best-effort
  fallback - a screenshot or photo of a document/whiteboard gets its text
  extracted; a photo with no text just attaches with nothing extracted.
  OCR setup (Python + Tesseract) is documented in `server/README.md`; if
  it's not installed, images/scanned PDFs still attach fine, they just
  won't have any text pulled out of them.
- **Generating PDF/Word/Excel/PowerPoint files** - via the tool-calling
  path, not a separate UI: describe what you want, and
  `pdf_create`/`docx_create`/`xlsx_create`/`pptx_create` get called
  automatically.

## Key design decisions

- **Single model, no fallback chain**: the model failing to load or
  respond is a real, surfaceable error - there's no other provider to
  silently retry.
- **Nothing throws uncaught**: `db/database.js`, `backendClient.js`, and
  every tool service wrap operations in try/catch and return a consistent
  `{success, data, error}` shape. Combined with the top-level
  `ErrorBoundary` in `App.js`, the app shouldn't show a blank crash
  screen.
- **Routing is understood, not pattern-matched**: `intentClassifier.js`
  asks the model itself to understand what a message needs, rather than
  scanning for exact hardcoded phrases. The old keyword list
  (`classifyTask()` in `localModels.js`) still exists, but only as a
  degraded fallback for when the classifier call itself can't be made.
- **Icons: `@expo/vector-icons` only**, never emoji or favicon-style
  glyphs - every icon is a proper icon component with explicit `size` and
  `color` props from `useTheme()`.

## Message actions (long-press menu)

Long-pressing a message bubble opens a floating context menu
(`src/components/MessageActionMenu.js`).

- **User's own message**: Copy, Edit.
- **Assistant message**: Copy, Regenerate, Like/Dislike (feedback is
  stored per message but not yet read back anywhere - see
  `SYSTEM_COMPONENTS.md`'s feedback-loop section).

**Edit** (user messages only) pulls the message's text back into the
composer; Save updates that row's content in place via
`chatStore.editMessage()`, stamping `edited_at`. Editing does NOT re-send
to the model or touch later messages - it's a correction to the
historical record, not a new turn.

## Theme & navigation

Three-way theme preference - **Auto** (follows the phone's system
setting), **Light**, or **Dark** - persisted to SQLite. Navigation is a
hand-rolled sidebar drawer (`src/components/SidebarDrawer.js`), built on
React Native's `Animated` + `PanResponder` only - deliberately not
`react-navigation`, to avoid pulling in `react-native-gesture-handler` +
`reanimated` as additional native dependencies.

## Known gaps

See `SYSTEM_COMPONENTS.md`'s "what still needs work" section and
`HARDENING_NOTES.md`'s "still open" section for the current, maintained
list - resumable plans on launch, live plan-progress handlers, a
feedback-loop consumer, an `agent_actions` audit table, and terminal
confirmation UI are the main ones. `.pptx` reading (not writing) is also
not built yet (see "File handling" above).

## Testing

`npm test` runs the Jest suite (`jest-expo` preset). Coverage right now
is deliberately focused on the highest-blast-radius, pure-logic pieces
of the state machine - the modules a silent bug in would be hardest to
notice and most costly to ship:

- `src/services/terminal/__tests__/commandSafety.test.js` - the
  HARD_BLOCKED / RISKY / safe tiers both terminal tools gate every raw
  command through.
- `src/services/execution/__tests__/permissionModes.test.js` - the
  five permission modes' allow/confirm/refuse decisions for every tool
  category (read, write, destructive, terminal).
- `src/services/planning/__tests__/planExecutor.test.js` -
  `computeReadySteps()`, the dependency-scheduling core of the
  hierarchical plan executor (single deps, fan-in deps, blocked
  propagation).

`.github/workflows/ci.yml` runs this suite on every push/PR to `main`.

**First-time setup note:** this project is on Expo SDK 57 /
`react-native@0.86.0`, which currently hits a known upstream
`jest-expo`/`react-native` peer-dependency conflict
([expo/expo#47435](https://github.com/expo/expo/issues/47435)) that
makes a plain `npm install` fail with `ERESOLVE`. The `overrides` entry
already in `package.json` (`"@react-native/jest-preset": "0.86.0"`) is
the documented workaround - run `npm install` once locally after
pulling this change so `package-lock.json` picks it up and gets
committed; CI installs from that updated lockfile from then on.

