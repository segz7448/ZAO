# Hardening Notes

Gaps found in a pass looking specifically for "what's missing to call
this professional-grade" - separate from `SYSTEM_COMPONENTS.md`'s five
architectural components (router, state, feedback, human-in-the-loop,
audit trail). This is security/reliability/process hygiene instead.
Status reflects what's fixed in this pass vs. still open.

## Fixed this pass

- **Unattended destructive terminal commands.** Neither terminal tool
  had any gate - the model (or a bad plan, or text pulled from a
  webpage during a browsing task) could run `rm -rf`, `git push
  --force`, `DROP TABLE`, or worse with nothing in between. Added
  `src/services/terminal/commandSafety.js`: a small set of catastrophic
  patterns (`rm -rf /`, `mkfs`, a fork bomb) are hard-blocked with no
  override; the broader destructive set (same list
  `riskClassifier.js` already used for planned steps) now requires
  `confirmed: true` to run at all. Wired into both
  `pcTerminalTool.js` and `termuxTerminalTool.js`. `riskClassifier.js`
  now imports the pattern list from here instead of keeping its own
  copy, so the two can't drift apart.
  - **Not fully closed**: nothing in the app sets `confirmed: true`
    yet, so risky commands currently fail closed rather than pausing
    for approval. See `SYSTEM_COMPONENTS.md`'s human-in-the-loop
    section for the remaining UI piece.
- **Default auth secret with no warning.** `server/config.js`'s
  `AUTH_TOKEN` fell back to the literal string
  `'change-me-to-a-real-secret'` with nothing telling you if you'd
  forgotten to change it - on a server bound to `0.0.0.0` and reachable
  over the public Cloudflare tunnel. `server/index.js` now logs a loud,
  impossible-to-miss warning at startup if the token is still the
  placeholder.
- **No rate limiting.** Added a crude in-memory sliding-window limiter
  (120 req/min/IP) to `server/index.js` - not about fairness (it's a
  single-user backend), just a ceiling on how fast a leaked token or a
  retry-storm bug can hammer the PC or the model.
- **No `.gitignore`.** Added one - `node_modules/`, `.env*`, `*.db`,
  build artifacts, and (since large model binaries have no business in
  git) `server/*.gguf`.

- **No uncertainty signal before an autonomous action, only after.**
  `selfReflection.js`'s critique pass only ever looks at a draft ANSWER
  already written - nothing rated confidence in a TOOL CALL before it
  ran, so in `acceptEdits`/`auto`/`bypassPermissions` mode a write or
  risky terminal command could execute unattended with no indication,
  before or after, of how sure the model actually was that it was the
  right call. Added `src/services/reasoning/actionConfidence.js`: a
  small forward-looking sibling of `selfReflection.js`, wired into
  `toolOrchestrator.js`'s tool loop as a new Gate 1.5 between the
  permission gate and the hooks gate. It only fires for calls the
  current permission mode is about to let run WITHOUT the confirmation
  `default` mode would have required (detected by re-checking against
  `'default'`, not a hardcoded tool list, so it can't drift out of sync
  with `permissionModes.js`). High confidence stays silent; medium
  surfaces a one-line `onStep` signal before the action executes; low
  overrides the mode's own auto-run setting and converts that specific
  call into an ordinary confirmation card via the existing
  `pendingConfirmation` / `approveAndRunPendingTool` path - "skip
  confirmation" is now earned per-action, not just handed out by the
  mode toggle. The assessment is also attached to that call's telemetry
  span (`preActionConfidence` / `preActionConcern` attributes) so it's
  queryable afterward too, not just visible in the moment.

## Still open

- **No tests, no CI.** Zero test files, no GitHub Actions or other
  pipeline. Nothing catches a regression before it ships. Given the
  amount of state-machine logic in `planning/`, `memory/`, and
  `terminal/`, this is the single highest-leverage gap left - those are
  exactly the modules where a silent logic error is expensive
  (destructive commands, corrupted plan state) and hard to notice by
  eye.
- **Human confirmation UI for risky terminal commands** (see above) -
  the gate exists, the "person taps Approve" surface doesn't yet.
- **CORS is `Access-Control-Allow-Origin: *`.** Lower priority than it
  looks - the client is React Native's `fetch`, not a browser page, so
  CORS isn't the enforcement boundary here the way it would be for a
  web app; `AUTH_TOKEN` is the real gate. Still worth narrowing if a
  browser-based client is ever added.
- **No secrets scanning / dependency audit in the workflow.** Nothing
  currently runs `npm audit` or a secret-scanner as part of any build
  step (there being no CI step at all is the root cause here too).
- **No structured error/observability layer.** `console.error` calls
  are real but ad hoc (~20 files, no consistent shape, nothing
  persisted) - same root gap as `SYSTEM_COMPONENTS.md`'s audit-trail
  section, just from the "ops" angle instead of the "why did the agent
  do that" angle. One `agent_actions` table + a bit more structure
  around what gets logged would close both at once.
