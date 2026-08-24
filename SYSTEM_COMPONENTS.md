# Other Components People Forget

`BRAIN_ARCHITECTURE.md`, `REASONING_ARCHITECTURE.md`, and
`MEMORY_ARCHITECTURE.md` cover the "thinking" parts of ZAO. This file
covers the parts of an agent system that don't fit any of those three
buckets but that a production agent breaks without - routing, state,
learning signal, human handoff, and audit trail. Same format as
`BRAIN_ARCHITECTURE.md`: a table of what these are, then what ZAO
actually has for each, file by file.

| Component | What it means | Does ZAO have it? |
|---|---|---|
| Router / classifier | Decides which brain, tool, or path a request should take | **Yes** - two layers (see below) |
| State management | Tracking "where am I in this multi-step task" across interruptions | **Partial** - persisted, not resurfaced |
| Feedback loop / learning signal | How the agent (or its trainers) improve over time | **Yes (dislikes only)** - captured and consumed, see below |
| Human-in-the-loop interface | A defined hand-off point where a person takes over | **Yes** - browser agent only |
| Audit / logging trail | A record of what the agent did and why | **Yes** - `agent_actions` table + Settings browse screen, see below |

## Router / classifier

ZAO actually has two separate routers, at two different layers, and
it's worth being precise about which is which:

1. **`src/services/intentClassifier.js`** - the "what kind of task is
   this" router. Asks the model itself to classify a message into
   `github` / `browsing` / `general` rather than matching a fixed
   phrase list (the old approach - `classifyTask()` in
   `src/config/localModels.js` - still exists as a degraded fallback
   for when the model call can't be made at all). This is the
   `FIXED_TASK_ROUTES` replacement referenced in the codebase's own
   comments.
2. **`src/services/brain/frontendBrain.js`** - `decideRoute()`, the
   layer above (1). Combines `intentClassifier.js`'s model-based call
   with the free local `shouldDecompose()` heuristic
   (`src/services/planning/planTypes.js`) to pick one of four routes:
   `HIERARCHICAL_PLAN`, `TOOL_TASK`, `BROWSING`, `CHAT`. This is the
   router `src/utils/orchestrator.js` actually calls on every message.
3. **`src/services/terminal/terminalRouter.js`** - `checkTerminalStatus()`
   hands the model live PC-reachability/internet status plus a
   plain-language summary before it calls `terminal_pc_run_command` -
   there's only the one terminal tool now, so this isn't picking between
   options, just telling the model whether that one tool is currently
   usable.

So: request → `frontendBrain.decideRoute()` (which brain/path) →, if it
lands in `HIERARCHICAL_PLAN` and a step needs a terminal tool,
`terminalRouter.js` first confirms the PC backend is reachable.
Three routers, three different granularities, no single God-router.

## State management

The building blocks are real and persisted, and the "resume where I
left off" experience is now wired end-to-end:

- **Per-step state**: every plan step has a DB-backed `status`
  (`pending` / `running` / `done` / `failed` / `blocked` /
  `awaiting_approval`) in `src/services/planning/planExecutor.js`.
  `findReadySteps()` re-derives what's runnable from that column on
  every call rather than caching progress in memory - so a partially-run
  plan and a resumed plan take the exact same code path
  (`runExecutionPlan()`'s own comment: *"a resumed plan IS the resume
  path"*).
- **Plan-level state**: `src/store/planStore.js` has
  `loadActivePlansOnLaunch()` and a `resumablePlans` array that surfaces
  any plan left running when the app was last closed.
- **Wired**: `App.js`'s init effect calls `loadActivePlansOnLaunch()`,
  and `resumablePlans` renders as a "Resume plan: ..." banner above
  `ChatScreen` (tap opens it via the existing `handleOpenPlan()`,
  dismissible via `dismissResumablePlan()`). The state was already
  tracked correctly on disk; this closed the last gap of resurfacing it
  across an app restart.
- **Live intra-plan progress**: `onPlanProgress` / `onPlanStep` are
  threaded through `src/utils/orchestrator.js` and `chatStore.js` passes
  handlers for both (`sendMessage`, `editMessage`, `regenerateMessage`
  all wire `onPlanProgress: (stage) => set({ planProgress: stage })` and
  `onPlanStep: (label) => set((state) => ({ planSteps: [...] }))`), same
  pattern `onGithubStep` already had - a running plan shows a live
  checklist in `ChatScreen.js`'s typing indicator, not a generic spinner.

## Feedback loop / learning signal

- **What's captured**: `messages.feedback` (`src/db/database.js`,
  `setMessageFeedback()`) stores `like` / `dislike` / `null` per
  assistant message, surfaced as the thumbs up/down buttons in
  `src/components/MessageActions.js` and set via
  `chatStore.js`'s `setFeedback()`. This part predates the fix below
  and is unchanged.
- **What's now consumed**: `src/services/memory/feedbackMemory.js`
  (new) is the "avoid this pattern" signal this section used to flag as
  missing, built the same shape as the existing procedural-memory loop
  (`proceduralMemory.js`: successful plan → reusable recipe) rather than
  full RLHF, which a locally-served 3B model with no training infra has
  no use for anyway:
  - `chatStore.js`'s `setFeedback()` fires `recordDislikeFeedback()`
    (fire-and-forget) the moment a message is marked disliked, passing
    the disliked reply plus the user message that led to it.
  - That distills the exchange into one short, general "avoid ..."
    instruction (a local model call, same pattern as
    `memoryEngine.js`'s `extractMemoriesFromTurn`) and stores it in the
    new `feedback_patterns` table (`src/db/database.js`). A
    newly-distilled instruction that's a close match for one already
    stored (token-overlap heuristic, same as `memoryEngine.js`'s
    `findLikelySupersededMemory` / `proceduralMemory.js`'s
    `findSimilarProcedure`) bumps that row's `occurrence_count` instead
    of duplicating it - this is the aggregation step: five separate
    "too verbose" dislikes become one pattern with `occurrence_count`
    5, ranked above a pattern that's only fired once.
  - `chatStore.js`'s `assembleHistory()` - the single place all three
    send paths (send/edit/regenerate) build the outbound prompt - now
    also calls `feedbackMemory.js`'s `getFeedbackGuidanceMessage()` and
    injects the top-ranked patterns as a system message, right
    alongside the semantic-memory block, gated behind the same
    `memoryEnabled` toggle.
  - Likes are deliberately NOT distilled into a mirror-image
    "reinforce" pattern - see `feedbackMemory.js`'s header comment for
    why. Raw like/dislike totals are still queryable via
    `getFeedbackStats()` for a future Settings display.
  - Known limitation carried over from the rest of the memory system:
    toggling a dislike back off doesn't retract an already-distilled
    pattern (same tradeoff `extractMemoriesFromTurn` already makes -
    nothing here is a reversible 1:1 log, it's a background learning
    signal).

## Human-in-the-loop interface

This one's fully built, but scoped to exactly one surface:

- **`server/browserAgent.js`** - the model can call a `needsHuman`
  action, which pauses the agent loop and marks the session
  `awaitingHuman`. The phone shows the live Playwright view
  (`server/browserStream.js` / `src/services/browserAgent/`) and real
  tap/type events the person makes get executed directly against the
  live page. `resumeAfterHuman()` hands control back to the model,
  continuing the *same* task/history rather than starting a new one -
  the model sees the page state the person left it in and picks up
  from there. Documented explicitly for CAPTCHAs, unexpected 2FA, and
  webcam/camera verification the agent has no way to do itself.
- **What doesn't have this**: the hierarchical planning system has its
  own, different human checkpoint -
  `src/services/planning/checkpointBalancer.js` +
  `AWAITING_APPROVAL` step status - but that's an *approve/reject a
  step before it runs* gate, not a *take over mid-action* handoff.
  `toolOrchestrator.js`'s flat tool loop (GitHub/filesystem/office/PDF
  tools) has neither - if one of those tools hit something requiring a
  person (an interactive prompt, an auth flow, a permission dialog),
  there's currently no `needsHuman`-equivalent for it to call.
- **Terminal + every other confirmable tool**: `src/services/terminal/commandSafety.js`
  gates `pcTerminalTool.js` - a destructive command (`rm -rf`, `git push
  --force`, `DROP TABLE`, etc.) is refused with `needsConfirmation: true`
  unless the call explicitly passes `confirmed: true`, and a handful of
  catastrophic ones (`rm -rf /`, `mkfs`, a fork bomb) are hard-blocked
  with no override at all. This now has the full human-in-the-loop UI to
  go with it: `ChatScreen.js`'s `PendingToolConfirmCard` renders off
  `message.pending_confirmation`, and a tap calls `chatStore.js`'s
  `approvePendingToolCall()` / `dismissPendingConfirmation()`, which
  reach `toolOrchestrator.js`'s `approveAndRunPendingTool()` - terminal
  commands re-run with `confirmed: true`; every other
  WRITE_TOOL/DESTRUCTIVE_TOOL re-runs directly, since a human tap
  approving the card IS the override for those. Covers every confirmable
  tool call the flat loop can produce, not just terminal commands.

## Audit / logging trail

Built, not missing - this section previously described it as the one
fully-missing piece; that was already stale when written.
`src/services/execution/telemetry.js` is exactly the "queryable record
of what the agent did and why" this used to call for:

- **Table**: `agent_actions` (`src/db/database.js`) - one row per real
  tool-call span: `trace_id`/`span_id`/`parent_span_id`,
  `session_id`/`conversation_id`, `name`/`tool_name`, `attributes_json`,
  `status`, `error_message`, `started_at`/`ended_at`. OpenTelemetry-
  shaped (trace/span/parent-span/attributes/status/timing), not a full
  OTel SDK - persisted locally, with an optional best-effort HTTP
  forward to a real OTLP collector if `otel_export_endpoint` is set
  (`telemetry.js`'s `maybeExport()`).
- **Write path**: `toolOrchestrator.js`'s flat tool loop calls
  `startSpan()`/`endSpan()` around every real tool call (Gate 3, after
  the permission/confidence/hooks gates), including
  `preActionConfidence`/`preActionConcern` from `actionConfidence.js` as
  span attributes. `planExecutor.js`'s `runStepTool()`/`runBrowserStep()`
  do the same now (one `traceId` per `runExecutionPlan()` call, shared
  across every step and resumed run) - a hierarchical plan's tool calls
  used to only reach `plan_step_actions` (that step's own detail view),
  invisible to this trail; both loops write to `agent_actions` now, so
  "why did ZAO do X three days ago" has one real answer regardless of
  which loop ran it.
- **Read path / UI**: `getTrace()`/`getRecentSpans()`
  (`telemetry.js`) back `SettingsScreen.js`'s `AuditTrailSection` -
  "View recent activity" opens a modal listing recent spans
  (timestamp, tool name, status, error if any), plus the
  `otel_export_endpoint` setting. Rendered, not orphaned - wired into
  the actual Settings screen tree.
- **What's still true**: ordinary `console.error`/`console.warn` calls
  are still scattered across ~20 files for live debugging - that's
  fine, it's a different, complementary layer (immediate terminal
  output vs. a durable per-call record), not a gap in `agent_actions`
  itself.
- **Distinct from, not a replacement for**: `plan_step_actions`'
  reasoning-vs-tool-call interleaving (`planExecutor.js`) is still the
  right place for a single step's full detail (real input/output per
  attempt, including retries) - `agent_actions` is the cross-loop,
  cross-conversation index on top, not a duplicate of that detail.

## Summary: what still needs work

- Nothing in this file - all five components (router, state, feedback,
  human-in-the-loop, audit trail) are now built and wired. Remaining
  gaps live in `HARDENING_NOTES.md` instead (no tests/CI, CORS,
  secrets scanning).

Everything else previously listed here (`resumablePlans` on launch,
live plan-progress handlers, and a confirmation surface for the flat
tool loop) is now built - see State management / Human-in-the-loop
above.
