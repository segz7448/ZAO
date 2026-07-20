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
| Audit / logging trail | A record of what the agent did and why | **No** - console logs only, not persisted |

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
3. **`src/services/terminal/terminalRouter.js`** - a narrower,
   within-tool router. `checkTerminalStatus()` doesn't pick the route
   itself; it hands the model live PC-reachability/internet status
   plus a plain-language recommendation, and the model (steered by the
   system prompt in `toolOrchestrator.js`) is the one that actually
   decides `terminal_pc_run_command` vs.
   `terminal_termux_run_command` per task. Routing logic lives in the
   model's judgment, not a hardcoded table - deliberately, per that
   file's own header comment.

So: request → `frontendBrain.decideRoute()` (which brain/path) →, if it
lands in `TOOL_TASK`, `toolOrchestrator.js`'s tool loop →, if a
terminal tool is on the table, `terminalRouter.js` (which terminal).
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
- **Partial fix (terminal only)**: `src/services/terminal/commandSafety.js`
  (new) now gates both `pcTerminalTool.js` and `termuxTerminalTool.js` -
  a destructive command (`rm -rf`, `git push --force`, `DROP TABLE`,
  etc.) is refused with `needsConfirmation: true` unless the call
  explicitly passes `confirmed: true`, and a handful of catastrophic
  ones (`rm -rf /`, `mkfs`, a fork bomb) are hard-blocked with no
  override at all. This closes the flat tool loop's worst exposure
  (unattended destructive shell commands) but isn't a full
  human-in-the-loop UI yet - nothing in the app currently sets
  `confirmed: true`, so today every risky terminal command simply fails
  closed rather than pausing for a person to approve it. The remaining
  work is a chat-level "Approve this command?" affordance
  (`MessageActionMenu.js`/`Toast.js` already have the visual language
  for this) that re-calls the tool with `confirmed: true` on approval.

## Audit / logging trail

The weakest of the five - there isn't one yet, in the "queryable record
of what the agent did and why" sense:

- What exists today is ordinary `console.error`/`console.warn` calls
  scattered across ~20 files (backend calls, DB failures, tool errors)
  - useful for live debugging in a terminal, gone the moment the
    process restarts, and not attached to a conversation, plan, or
    step.
- What's adjacent but not the same thing: `plan_step_actions`'
  reasoning-vs-tool-call interleaving (`planExecutor.js`) and the
  `provenance` memory type documented in
  `src/services/memory/memoryTypes.js` (*"lets a memory be traced back,
  audited, or selectively invalidated if its source turns out to be
  wrong"*) - both are about tracing a fact or action back to its
  source, not about a durable log of every tool call/decision the agent
  made.
- **What's missing concretely**: no table (or file) recording, per tool
  call, what was called, with what arguments, what it returned, which
  plan/step/conversation it belongs to, and when. Without it, "why did
  ZAO do X three days ago" has no answer beyond scrolling chat history
  and hoping the reasoning was said out loud. A minimal version would
  be a new `agent_actions` SQLite table (mirroring the existing
  `plan_step_actions` shape) written to from `toolOrchestrator.js`'s
  tool-call loop and `planExecutor.js`'s step execution, plus a simple
  read-only screen to browse it - the DB and UI patterns for exactly
  this already exist elsewhere in the app (`PlanScreen.js`,
  `StepDetailSheet.js`), they're just not pointed at tool calls in
  general.

## Summary: what still needs work

- Surface `resumablePlans` on launch (state management).
- Live plan-progress handlers in `chatStore.js` (state management).
- A `needsHuman`-equivalent for the flat tool loop, not just the
  browser agent and the plan-approval gate (human-in-the-loop).
- An `agent_actions` table + browse screen (audit/logging trail) - the
  single fully-missing piece; everything else here is "built but not
  finished," this one hasn't been started.
