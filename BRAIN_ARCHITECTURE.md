# ZAO's Brain Architecture

Full taxonomy + ZAO's classification against it lives in
`src/services/brain/brainTypes.js` (read that first - this file is just
a map of what got wired up and where).

## The four brain types

| Type | What it means | Does ZAO use it? |
|---|---|---|
| Dense transformer | One network, every parameter active every token | **Yes** - the model itself: Qwen2.5-Coder-3B, served by the PC backend |
| Mixture-of-Experts (MoE) | Many sub-networks, only some active per token | **No** - single 3B dense model, no expert routing; not planned |
| Multi-brain / ensemble | Separate roles (or models) for separate jobs | **Yes** - one model, many system-prompt "roles" (see `BRAIN_ROLES` in `backendBrain.js`) |
| Hybrid symbolic-neural | A rules engine wrapped around neural judgment calls | **Yes** - `src/services/planning/` (deterministic graph/DB state machine) + narrow model calls inside it |

Claude itself (Haiku/Sonnet/Opus) is a single dense transformer with no
MoE and no multi-brain routing *inside* one response - the multi-role,
hybrid-symbolic structure people associate with "Claude planning things"
lives in the product surface around it, not the model. ZAO's
architecture mirrors that split on purpose.

## What was already built vs. what was missing

Before this pass:
- `src/services/planning/` (8 planner modules, `planCoordinator.js`,
  `planExecutor.js`) was **fully implemented** - a complete
  Strategic → Project → Task → Execution planning system with
  dependency scheduling, risk gating, recovery, checkpoints, and full
  SQLite persistence.
- `src/store/planStore.js` **fully wraps** it for `PlanScreen.js`.
- `PlanScreen.js` is a **complete, working UI** - approve/reject steps,
  milestone strip, checkpoint bar, the works.
- **None of it was reachable.** `src/utils/orchestrator.js` (the one
  function every chat send/edit/regenerate calls) never called
  `planCoordinator`/`planExecutor`. `App.js` never mounted `PlanScreen`
  at all. A message could only ever reach plain chat, the flat
  ReAct-style tool loop (`toolOrchestrator.js`), or the live browser
  agent - the entire hierarchical planning system was orphaned code.

## What this pass wired up

1. **`src/services/brain/brainTypes.js`** (new) - the taxonomy above,
   plus `ZAO_BRAIN_PROFILE` naming exactly which file implements which
   architecture.
2. **`src/services/brain/frontendBrain.js`** (new) - the phone-local
   "reflex" brain. `decideRoute(messageText)` combines the existing
   ROUTER-role call (`intentClassifier.js`) with the free local
   `shouldDecompose()` heuristic (`planTypes.js`) to pick one of four
   routes: `HIERARCHICAL_PLAN`, `TOOL_TASK`, `BROWSING`, `CHAT`.
3. **`src/services/brain/backendBrain.js`** (new) - the PC-side
   "cortex" brain. `BRAIN_ROLES` names every model role already spread
   across the codebase (router, 6 planner roles, tool executor,
   conversationalist). `runHierarchicalPlan()` is the new piece: it
   calls `planCoordinator.buildPlan()` then runs every resulting
   execution plan via `planExecutor.runExecutionPlan()`, in order,
   returning a chat-ready summary + the plan's id.
4. **`src/utils/orchestrator.js`** - now calls `frontendBrain.decideRoute()`
   instead of `classifyIntent()` directly, and added the
   `HIERARCHICAL_PLAN` branch that calls `backendBrain.runHierarchicalPlan()`
   and returns `data.planId` on success.
5. **`src/db/database.js`** - added a `plan_id` column on `messages`
   (idempotent migration, same pattern as every other column added
   post-launch) so an assistant reply can point back at the plan it
   came from.
6. **`src/store/chatStore.js`** - threads `conversationId` into every
   `sendMessageOrchestrated()` call (needed so a built plan is
   associated with the right conversation) and carries `planId` through
   into the persisted message as `plan_id`.
7. **`src/screens/ChatScreen.js`** - a reply with `plan_id` now renders
   a "View Plan" chip that calls `onOpenPlan(planId)`.
8. **`App.js`** - actually mounts `PlanScreen` (a `'plan'` screen state
   that didn't exist before), wired to `planStore`'s
   approve/reject/cancel/checkpoint actions.

## What still needs work (not done in this pass)

- **MoE**: intentionally not implemented (see `brainTypes.js`) - not a
  gap, just documented as out of scope for a single 3B model.

Resumable-plans-on-launch and live plan-build/run progress in chat -
previously listed here as gaps - are both wired now: `App.js`'s init
effect calls `loadActivePlansOnLaunch()` and renders a resume banner
(`handleOpenPlan()` on tap), and `chatStore.js` passes `onPlanProgress`/
`onPlanStep` handlers in `sendMessage`/`editMessage`/
`regenerateMessage` alike, so a running plan shows a live checklist
instead of a generic spinner. See `SYSTEM_COMPONENTS.md`'s "State
management" section for the current, non-stale version of this.
