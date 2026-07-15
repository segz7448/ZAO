# ZAO

Fully on-device AI assistant for Android. Chat, coding, and reasoning/math
all run locally via `llama.rn` (llama.cpp) - no OpenRouter, no per-message
API key, no rate limit, no network call for any of that. The only cloud
calls left in the app are Gemini (image generation, image editing, and
photo/screenshot OCR - your own API key) and Hugging Face (Whisper speech-
to-text, until a local STT model replaces it). Beyond chat, ZAO also acts
as an on-device agent: it can browse the web, push code to GitHub, run
real shell commands via Termux, and create/read PDF/Word/Excel/PowerPoint
files - all invoked automatically by the local coder model, not through
dedicated buttons.

## Models in this project

| Model | Where it runs | Used for |
|---|---|---|
| **Qwen3 4B** (Q4_K_M) | Local, `llama.rn` | General chat, business writing |
| **Qwen2.5 Coder 3B Instruct** (Q4_K_M) | Local, `llama.rn` | Coding, and as the tool-calling "router" for GitHub/filesystem/terminal/PDF/Office/browser-agent tasks |
| **Phi-4 Mini Instruct** (Q4_K_M) | Local, `llama.rn` | Reasoning and math |
| **Gemini** (`gemini-2.5-flash-image` + `gemini-2.5-flash`) | Cloud API, user's own key | Image generation, image editing, vision/photo OCR |
| **Whisper Large V3** | Cloud, Hugging Face Inference | Speech-to-text (mic button, Voice Mode) |

Registered in code at `src/config/localModels.js` (`LOCAL_MODELS`, the three
local GGUF models) and `src/providers/gemini.js` / `src/providers/huggingface.js`
(the two cloud calls). See "Local models" and "Cloud calls" below for detail
on each.

## Architecture

```
src/
  db/database.js              SQLite layer. Every function returns {success, data, error},
                               never throws. This is the offline-first source of truth -
                               conversations, messages, preferences, API key metadata,
                               memory facts, usage events, model health.
  config/
    localModels.js             Single source of truth for the three local models: source/
                               local GGUF filenames, classifyTask() (keyword-based task
                               detection), and FIXED_MODEL_ROUTE (task category -> model
                               key, no manual override, no fallback chain).
    trialKeys.js                resolveApiKey() - the one place user-key-vs-trial-key
                               priority is decided. Only Hugging Face has a baked-in
                               trial key; Gemini and GitHub always require the person's
                               own key/token.
  providers/
    adapterUtils.js             Shared timeout wrapper + error classification, used by
                               every cloud call (Gemini, Hugging Face).
    gemini.js                   Image generation, image editing, and vision/OCR via the
                               Gemini API - the one deliberate cloud exception for
                               something with no local model yet. User's own key only.
    huggingface.js               Whisper speech-to-text only now (see Cloud calls below).
  services/
    llama/
      llamaEngine.js              Local inference engine. Keeps one LlamaContext resident
                                 in memory at a time (only one model fits comfortably at
                                 Q4_K_M on a phone) and swaps it when a different model
                                 key is requested. sendMessage() mirrors the old cloud
                                 provider adapters' {success, data, error} shape.
      modelImportTool.js          One-time SAF folder grant (Settings > Local Models) +
                                 native streaming copy of each GGUF from wherever it lives
                                 (e.g. an SD card) into app-private storage, since
                                 initLlama() needs a real file:// path, not a content:// URI.
    toolOrchestrator.js           The "project manager" pattern: the local Qwen2.5 Coder
                               model sees OpenAI-style tool schemas for GitHub, filesystem,
                               PDF, Office (docx/xlsx/pptx/csv), and Termux, decides which
                               to call and in what order, and the chat only ever shows a
                               running checklist ("Working... Created repo... Pushed to
                               GitHub"). The person never sees a "tools" button.
    github/githubTool.js          Real GitHub REST/Git Data API calls (create repo, read/
                               commit files, branches, PRs) using the person's own
                               Personal Access Token. Not the `git` binary - there's no
                               git available inside the RN runtime - this drives the same
                               end state (blob -> tree -> commit -> ref update) over HTTPS.
    filesystem/filesystemTool.js  Device-wide file operations (create/move/rename/delete/
                               zip/extract) under a folder the person grants once via
                               Android's Storage Access Framework - required because
                               Android 10+ blocks arbitrary path access outside SAF.
    terminal/terminalTool.js      Dispatches real shell commands to Termux via a native
                               module (see plugins/withTermuxRunCommand below) and returns
                               actual stdout/stderr/exit code - not a simulated shell.
    pdf/pdfTool.js                 Create/merge/split PDFs (pdf-lib, pure JS). OCR is NOT
                               here - reading text out of a scanned/image PDF is a vision
                               problem, handled by Gemini instead (see Cloud calls).
    office/
      docxTool.js                  Create Word documents (docx library).
      xlsxTool.js                  Create spreadsheets + CSV (SheetJS-style, live formulas
                                  supported via `=`-prefixed cell values).
      pptxTool.js                  Create PowerPoint decks (pptxgenjs).
    browserAgent/
      agentLoop.js                  The on-device browser agent's "brain" - an AgentSession
                                  is a stateful, resumable conversation (system prompt +
                                  every task + action/observation pairs) driven by the local
                                  Qwen2.5 Coder model. Replaces the old server-based
                                  Internet Router entirely - zero servers, zero tunnels.
      BrowserAgentView.js /
      BrowserAgentPiP.js             The "hands" - the actual on-device WebView the agent
                                  controls, one persistent instance for the app's lifetime
                                  so a follow-up task picks up wherever the last one left
                                  off (open page, filled-in form, etc.).
      domBridge.js                   Injects JS into the WebView to read/click/fill the
                                  live DOM and report back to agentLoop.js.
    memory/memoryEngine.js         Long-term, cross-conversation memory (name, preferences,
                               ongoing projects) - extracted in the background by the local
                               coder model after each turn, re-injected as a system message
                               into every future conversation. Toggle in Settings > Memory.
    hf/
      hfTaskClient.js               Shared low-level client for Hugging Face's task-specific
                                  REST endpoints.
      whisper.js                    Speech-to-text - feeds the mic button and Voice Mode.
    tts/androidTts.js               Native Android text-to-speech (expo-speech) for Voice
                               Mode's spoken replies - not a cloud TTS model.
    audio/useZaoAudioRecorder.js    Recording hook (expo-audio, not the removed expo-av).
    video/frameSampler.js            Extracts video frames (expo-video-thumbnails) - built
                               for future video-understanding use, not currently wired to
                               a model since local models here are text-only.
    fileTypes.js / fileProcessor.js  Entry point for any attached file - routes to the right
                               extractor (text/CSV/ZIP/PDF/DOCX/PPTX/XLSX), normalizes every
                               result into one shape, never throws.
    textExtraction.js / zipHandler.js  On-device plain text/CSV and ZIP extraction
                               (expo-file-system + papaparse / jszip, no server round-trip).
    documentExtraction.js           Client for the (optional) Supabase Edge Function PDF/
                               DOCX extraction path - see Supabase section below.
  files/
    fileTypes.js, pdfExtractor.js,
    officeExtractors.js, zipExtractor.js  On-device extraction helpers for reading uploaded
                               PDF/Office/ZIP content into the chat as context - the reading
                               counterpart to services/pdf and services/office's creation
                               tools.
  utils/
    orchestrator.js                The one function the UI calls to send a message.
                               Checks for an attached image first (routes to Gemini
                               vision/OCR), then GitHub/tool tasks, then the browser agent
                               toggle, then image generation (Gemini), then falls through
                               to normal local chat completion via classifyTask() + 
                               FIXED_MODEL_ROUTE. Also exports editImageOrchestrated() for
                               Gemini image-editing turns. Never throws.
    saveImageToGallery.js           Saves a message's image (attached or generated) to the
                               device photo gallery via expo-media-library.
    sseClient.js                     Shared SSE/streaming helper.
  store/
    chatStore.js                    Zustand store: messages, active conversation,
                               conversation list, sending state, browser-agent step
                               progress. Builds the assistant message row (including a
                               generated/edited image's local file path) from whatever
                               the orchestrator returns.
    preferencesStore.js              Zustand store: theme, memory/browser-access toggles,
                               API key status (Hugging Face, Gemini, GitHub, browser
                               router), SAF grants (filesystem + local-model folder).
    themeStore.js                    Auto/Light/Dark preference, persisted to SQLite.
  screens/
    ChatScreen.js                    Main chat UI - message bubbles (including both
                               user-attached and AI-generated/edited images via the same
                               local_image_path field), composer, browser-agent step list.
    SettingsScreen.js                 Local Models (import/manage GGUFs), API Keys
                               (Hugging Face, Gemini, GitHub), Browser Agent, Memory,
                               Usage & Activity.
    BrowserAgentScreen.js             Full-screen browser agent view.
    VoiceModeScreen.js / VoiceSettingsSheet.js  Continuous voice conversation (Whisper in,
                               native Android TTS out) and its voice/rate settings.
  components/
    ModelPickerSheet.js, ErrorBoundary.js, SidebarDrawer.js, AttachmentSheet.js,
    MarkdownText.js, MessageActionMenu.js, MessageActions.js, Toast.js,
    ImageViewerModal.js         UI building blocks - see inline comments per file.
  theme/                        tokens.js (full light+dark palettes) + useTheme.js (the
                               hook every screen/component should pull colors from).
  supabase/client.js             Optional Supabase client + auth - app works fully offline
                               without ever calling this.
  sync/syncEngine.js             Background push/pull between local SQLite and Supabase,
                               fire-and-forget, never on the critical path.
  storage/fileStorage.js          Upload/download helpers for the 'zao-files' Supabase
                               Storage bucket (used for generated-image backup and browser-
                               agent step snapshots when signed in).

plugins/withTermuxRunCommand/    Expo config plugin: copies the native Kotlin
                               TermuxRunCommand module into the generated android/ project,
                               registers it in MainApplication, and adds the
                               com.termux.permission.RUN_COMMAND manifest permission -
                               regenerated correctly on every `expo prebuild`, no manual
                               Android Studio editing needed.

supabase/
  schema.sql                    Full Postgres schema (tables, RLS, storage bucket +
                               policies, auto-provisioning trigger). Optional - only
                               needed if you want cross-device sync.
  functions/extract-document/    Edge Function (Deno) for server-side PDF/DOCX text
                               extraction - one of the only features that isn't fully
                               offline-capable (see "File handling" below).
```

## Local models

All three local models are GGUF files (Q4_K_M quantization) run through
`llama.rn`, which wraps llama.cpp. They are **not bundled with the app** - a
multi-GB model in the APK isn't practical - instead:

1. Grant folder access once in **Settings > Local Models** (Android's system
   folder picker, via Storage Access Framework - works even for a path like
   an SD card that JS can't otherwise reach directly).
2. Tap import for each model. ZAO finds it by exact filename inside that
   folder and streams a native copy into app-private storage
   (`FileSystem.documentDirectory`), since `initLlama()` needs a real
   `file://` path, not a SAF `content://` URI.
3. Once imported, the model is ready - no further network or setup needed.

**Routing is fully automatic** (`src/config/localModels.js`), based on
keyword detection in `classifyTask()` - there's no manual model picker and
no fallback chain, since every local model is free/unlimited/always-on
anyway (a failure - not imported yet, out of memory - is a real error
surfaced to the person, not silently retried on a different model):

| Task category | Routes to |
|---|---|
| Coding (build/debug/component/refactor/etc.) | Qwen2.5 Coder 3B |
| Reasoning / math (solve/calculate/proof/equation/etc.) | Phi-4 Mini Instruct |
| General chat, business writing, everything else | Qwen3 4B |

Only one model is kept resident in memory at a time - a phone doesn't have
room for more than one loaded simultaneously at this size class - so
switching task categories mid-conversation releases the previous context
and loads the new one (`llamaEngine.js`'s `ensureModelLoaded()`).

Qwen2.5 Coder 3B additionally acts as the **tool-calling router**: GitHub,
filesystem, terminal, PDF, and Office (docx/xlsx/pptx/csv) requests all go
through it via `src/services/toolOrchestrator.js`, using real OpenAI-style
`tool_calls` against actual JS functions (llama.rn's Jinja chat-template
support makes this possible fully on-device).

## Cloud calls

Two cloud calls remain, both because there's no local/on-device equivalent
yet - both use the person's own API key/token, never a shared backend:

- **Gemini** (`src/providers/gemini.js`) - image generation
  (`gemini-2.5-flash-image`), image editing (same model, existing image +
  instruction), and vision/OCR (`gemini-2.5-flash`, image + optional
  question -> text). Add your own key in **Settings > API Keys**; there is
  no trial allowance for this one (see `src/config/trialKeys.js`). This is
  specifically for genuine **image-based** OCR (a photo, a screenshot, a
  scanned page attached as an image) - reading text out of a structured
  PDF/DOCX/PPTX/XLSX file is a different problem and stays entirely local,
  via the pdf/office tools routed through Qwen2.5 Coder.
- **Hugging Face** (`src/providers/huggingface.js`) - Whisper Large V3
  speech-to-text only, feeding the mic button and Voice Mode. A small trial
  key can be baked in at build time (see GitHub Secrets below); your own key
  always takes priority if you add one.

## GitHub, filesystem, and terminal access

These are real, not simulated:

- **GitHub** - add a Personal Access Token with `repo` scope in
  **Settings > API Keys**. Uses the REST/Git Data API (create blob -> tree
  -> commit -> update ref) since there's no `git` binary on-device - the
  end result in the repo is identical to a normal push.
- **Filesystem** - grant a folder once via Android's system folder picker
  (Settings), then the coder model can create/move/rename/delete/zip/
  extract files in it on request.
- **Terminal** - requires Termux installed with the one-time
  `RUN_COMMAND` permission granted (the app's Termux plugin adds the
  manifest permission automatically; Termux itself still needs
  `allow-external-apps` set and the Android permission prompt accepted
  once). Runs real shell commands (`npm install`, `pip install`,
  `gradlew`, etc.) and returns actual stdout/stderr/exit code.

None of these have dedicated buttons - you just ask in plain language, and
`toolOrchestrator.js` (driven by the local coder model) decides which
tool(s) to call and shows a running checklist as it works.

## Browser agent

Toggle the composer's globe icon to let ZAO browse the web on request. This
is fully on-device: a real WebView (`BrowserAgentView.js`/
`BrowserAgentPiP.js`) that the local coder model reads/clicks/fills via
injected JS (`domBridge.js`), directed by a resumable `AgentSession`
(`agentLoop.js`) that persists across multiple tasks in the same
conversation. Replaces an earlier server-based design entirely - no backend,
no tunnel, no self-hosted service required.

## Key design decisions

- **Offline-first for everything except the two cloud calls above**: every
  message is written to local SQLite immediately; Supabase sync (optional,
  see below) is a background layer on top, never on the critical path.
- **No fallback chains for local models**: a local model failing to load or
  respond is a real, surfaceable error - there's no other provider to
  silently retry, unlike the old OpenRouter/Hugging Face cascade this app
  used to have.
- **Nothing throws uncaught**: `db/database.js`, `providers/*`,
  `utils/orchestrator.js`, and the tool services all wrap every operation
  in try/catch and return a consistent `{success, data, error}` shape.
  Combined with the top-level `ErrorBoundary` in `App.js`, the app should
  never show a blank crash screen.
- **Icons: `@expo/vector-icons` only, never emoji or favicon-style glyphs**.
  Every icon (composer "+", camera/photos/files tiles, mic, send, menu,
  settings gear, close, checkmarks, sparkles, attach clip, sync notice,
  warning state, etc.) must be a proper icon component
  (`Ionicons`/`MaterialIcons`/`MaterialCommunityIcons`) with explicit `size`
  and `color` props from `useTheme()`. `@expo/vector-icons` ships bundled
  with `expo` already - no extra install needed.

## Setup

```bash
npm install
npx expo start          # dev server, scan QR with Expo Go for quick iteration
npx expo prebuild --platform android --clean   # generate native android/ project
```

APK builds happen via GitHub Actions on push to `main` (see
`.github/workflows/build-apk.yml`). It runs `expo prebuild` fresh every
time, so `android/` is gitignored and never committed.

After installing, import your local models (Settings > Local Models - see
"Local models" above) before expecting chat/coding/reasoning to work; add a
Gemini key (Settings > API Keys) before expecting image generation, image
editing, or photo OCR to work.

## Supabase setup (optional - only needed for cross-device sync)

1. Create a project at supabase.com.
2. Go to **SQL Editor > New query**, paste the entire contents of
   `supabase/schema.sql`, and run it. Safe to re-run any time - every
   statement uses `if exists`/`if not exists`/`or replace`.
3. Go to **Settings > API**, copy your Project URL and `anon public` key.
4. Copy `.env.example` to `.env` and fill in those two values.
5. Enable email auth (or whatever provider you want) under
   **Authentication > Providers**.

Sync is entirely opt-in: signed-out users get full offline local
functionality via SQLite, and nothing calls Supabase until a user signs in.
`syncNow()` (`src/sync/syncEngine.js`) runs on app start and after every
completed message, always in the background - never blocks the chat UI, and
no-ops silently if signed out or offline.

## GitHub Secrets (trial key + Supabase)

The build workflow (`.github/workflows/build-apk.yml`) reads these from
**Settings > Secrets and variables > Actions** and injects them as
`EXPO_PUBLIC_*` env vars at build time, baked into the compiled JS bundle:

| Secret name | Used for |
|---|---|
| `SUPABASE_URL` | Supabase project URL (optional) |
| `SUPABASE_ANON_KEY` | Supabase anon/public key (optional - safe to embed, RLS does real access control) |
| `HUGGINGFACE_TRIAL_KEY` | Small default Whisper allowance so voice input works before adding your own key |

**Do NOT add a Supabase service role key here** - it bypasses RLS entirely
and is extractable from the built APK by decompiling it. Service role
belongs only in a trusted server-side context (Supabase Edge Functions),
never in a client app.

**There is deliberately no Gemini or GitHub trial secret.** Both require the
person's own account/key - Gemini because it's a paid-tier-capable API with
no small free allowance to bake in safely, GitHub because repo actions have
to happen under the person's own identity. `resolveApiKey()`
(`src/config/trialKeys.js`) is the single place user-key-vs-trial-key
priority is decided for the one provider (Hugging Face) that has a trial
key at all.

## Secure API key storage

User-provided keys/tokens (Hugging Face, Gemini, GitHub) are stored via
`expo-secure-store`, using Android Keystore (hardware-backed encryption on
most devices) rather than plain SQLite. The `api_keys` table in local
SQLite only holds non-sensitive metadata (which provider has a key, whether
it's user-provided, when it last changed) - the actual `key_value` lives
only in SecureStore. See `src/db/database.js`'s `storeApiKey`/`getApiKey`/
`deleteApiKey` comments for the full split.

The Hugging Face trial key baked in via GitHub Secrets is NOT run through
secure storage - it's embedded directly in the JS bundle via
`EXPO_PUBLIC_*`, a different and already-accepted tradeoff for a small
trial allowance, not a place a real per-user secret should live.

## Theme system & navigation

Three-way theme preference - **Auto** (follows the phone's live system
setting), **Light**, or **Dark** - set in Settings > Appearance and
persisted to SQLite so it's sticky across restarts. `src/theme/tokens.js`
holds both full color palettes; `src/theme/useTheme.js` is the hook every
screen calls to get the resolved theme object.

Navigation is a hand-rolled sidebar drawer (`src/components/SidebarDrawer.js`),
built on React Native's `Animated` + `PanResponder` only - deliberately not
`react-navigation`, to avoid pulling in `react-native-gesture-handler` +
`reanimated` as additional native dependencies. Shows conversation history
(newest first, auto-titled), a "New chat" action, and a Settings gear
pinned next to the user row.

## File handling

ZAO can read images, PDF, Word (.docx), PowerPoint (.pptx), Excel (.xlsx),
ZIP archives, CSV, and plain text/code files attached via the "+" button -
and separately, create new PDF/Word/Excel/PowerPoint/CSV files on request
via the tool-calling path (`services/pdf`, `services/office`).

- **Images** - sent to Gemini vision/OCR (`src/providers/gemini.js`) along
  with any caption/question typed alongside the attachment. Requires a
  Gemini key configured; if not, the orchestrator returns a clear
  "add your Gemini key" message rather than silently ignoring the image.
- **CSV, plain text/code files** - extracted entirely on-device
  (`src/services/textExtraction.js`) via `expo-file-system` + `papaparse`.
- **ZIP archives** - unzipped entirely on-device (`jszip`, pure JS), capped
  at 30 entries / ~60,000 combined characters so a huge archive can't hang
  the app or blow out a model's context window.
- **PDF and Word (.docx) reading** - on-device extraction is preferred
  (`src/files/pdfExtractor.js`, `src/files/officeExtractors.js`); the
  Supabase Edge Function path (`documentExtraction.js` +
  `supabase/functions/extract-document/`) remains available as an optional
  server-side extractor for cases the on-device path can't handle, but
  requires being signed in (file uploads to private storage, is read, then
  deleted).
- **Generating PDF/Word/Excel/PowerPoint files** - via the local
  tool-calling path (Qwen2.5 Coder as router), not a separate UI: describe
  what you want, and `pdf_create`/`docx_create`/`xlsx_create`/`pptx_create`
  get called automatically. See `src/services/toolOrchestrator.js`'s tool
  schemas for exactly what each can produce.

**Deploying the edge function** (one-time, or after editing
`supabase/functions/extract-document/index.ts`):
```bash
npx supabase functions deploy extract-document
```
Requires `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` set as secrets on
the Supabase project itself (Project Settings > Edge Functions > Secrets),
never in the app's GitHub Secrets.

## Message actions (long-press menu)

Long-pressing a message bubble opens a floating context menu
(`src/components/MessageActionMenu.js`): background dims/blurs, the bubble
pops slightly, a haptic fires, the menu fades/scales in.

- **User's own message**: Copy, Edit.
- **Assistant message**: Copy, Regenerate (re-runs the orchestrator against
  the prior user turn). Read Aloud / Like / Dislike are wired as optional
  callback props on `MessageActionMenu` - each row only renders if its
  callback is actually passed in from `ChatScreen.js`.

**Edit** (user messages only) pulls the message's text back into the
composer and swaps Send for Save; the original message stays visible while
editing (no flicker from removing/re-adding it mid-type), and Save updates
that row's `content` in place via `chatStore.editMessage()` /
`db/database.js`'s `updateMessage()`, stamping `edited_at`. Editing does
NOT re-send to the model or touch later messages - it's a correction to the
historical record, not a new turn.

## Voice

- **Mic button** (composer) - one-time recording -> Whisper transcription
  -> appended to the text input.
- **Voice Mode** (waveform button) - full-screen continuous conversation:
  mic capture -> Whisper -> the same orchestrated `chatStore.sendMessage()`
  call typed messages use (so it's persisted and routed exactly the same
  way) -> native Android TTS speaks the reply aloud. No separate "voice
  conversation" data model - it's the same messages, same history.

## Known gaps / not yet built

- **Local speech-to-text** - Whisper (Hugging Face) is still the only STT
  path; a local model would remove the last always-on cloud dependency
  after Gemini's image features.
- **Attached/generated images and Supabase sync** - local images (both
  user-attached and Gemini-generated/edited) persist fine on-device via
  `local_image_path`, but aren't yet mirrored to Supabase Storage for
  cross-device access the way text messages are (see
  `src/storage/fileStorage.js`'s `uploadGeneratedImage`, which is wired for
  generated images specifically but not user attachments yet).
- **Markdown renderer** (`src/components/MarkdownText.js`) is a lightweight
  hand-rolled parser (bold/italic/inline code/code blocks/headers/lists) -
  no tables, no links - deliberately, to avoid adding
  `react-native-markdown-display` as more native/build surface area.
- **Sign in / sign up screen** - client functions exist
  (`src/supabase/client.js`), no UI wired up yet; the app works fully
  local/signed-out in the meantime, and the sidebar/chat greeting show
  placeholder names until this exists.
- **Video understanding** - `frameSampler.js` can extract frames from a
  video, but none of the three local text models or Gemini's current
  wiring here consume them yet; video isn't a recognized attachment type.

## Notes on API terms

Use your own Hugging Face account/key for Whisper, your own Gemini API key,
and your own GitHub Personal Access Token. Provider terms generally
prohibit using multiple accounts to multiply free-tier quota - ZAO's
architecture is BYO-key specifically so quota scales with the person using
it, not through account pooling.
