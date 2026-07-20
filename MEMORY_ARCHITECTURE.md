# ZAO's Memory Architecture

Full taxonomy + ZAO's classification against it lives in
`src/services/memory/memoryTypes.js` (read that first - this file is
just a map of what got wired up and where, same relationship
`BRAIN_ARCHITECTURE.md` has to `brainTypes.js`).

## The memory types

| Type | What it means | Does ZAO use it? |
|---|---|---|
| Parametric | Knowledge baked into the model's weights | **Yes** - the model itself, served by the backend. Not something this app manages. |
| Context window (raw) | The current conversation as sent this turn | **Yes** - `chatStore.js` assembles it every turn |
| Working-memory compaction | Rolling summary once a conversation outgrows a comfortable prompt size | **Yes (new this pass)** - `src/services/memory/workingMemory.js` |
| Episodic | Persisted raw transcript of specific past interactions | **Yes** - `conversations`/`messages`/`plan_steps` tables |
| Semantic | Durable extracted facts, not tied to one conversation | **Yes** - `src/services/memory/memoryEngine.js` |
| Procedural | "How to do X" recipes distilled from past successes | **Yes (new this pass)** - `src/services/memory/proceduralMemory.js`, shared by the hierarchical planner AND the flat tool loop (later addition, see below) |
| Vector / retrieval | Similarity search over a knowledge base (RAG-style) | **Yes (new this pass)** - `src/services/memory/retrievalMemory.js`, lexical (BM25-lite) not embedding-based |
| Scratchpad | Ephemeral in-run reasoning, discarded after | **Yes (pre-existing)** - `server/browserAgent.js`'s session history, `toolOrchestrator.js`'s ReAct loop |
| Prospective | Remembering to do something at a future time/trigger | **Yes (later addition)** - `src/services/reminders/reminderService.js`, backed by a ZAO-owned `reminders` table, expo-notifications as delivery only |
| Provenance | Where a memory/procedure came from | **Yes** - `source_conversation_id` / `source_plan_id` columns riding along on the stores above |

## What was already built vs. what was missing

Before this pass, ZAO already had two of the seven core types working
end to end:

- **Episodic** - `conversations`/`messages` in `src/db/database.js`,
  full CRUD, rendered by `ChatScreen.js`.
- **Semantic** - `src/services/memory/memoryEngine.js` + the `memories`
  table: automatic background extraction, explicit "remember
  this"/"forget that" commands, injected as a system message into
  every new conversation.

What was missing:

- **No context-window budgeting.** `chatStore.js` sent the ENTIRE
  message history to the model on every turn, unconditionally. Fine for
  a short chat; unbounded for a conversation used daily over months -
  eventually either overflows n_ctx or silently pushes early turns out
  in a way nothing tracked or could recover.
- **No cross-conversation recall.** Once a conversation was closed, the
  only way anything from it resurfaced was if `memoryEngine.js` had
  extracted a durable fact from it. A specific remembered EXCHANGE (not
  a distilled fact) from an old, closed conversation was simply gone
  unless the person scrolled back to find it themselves.
- **No procedural memory.** The hierarchical planner
  (`src/services/planning/`, wired up to the chat entry point in the
  brain-architecture pass) builds a full step-by-step plan from
  scratch for every goal, even one very similar to something that
  already succeeded before. Nothing captured "this approach worked" as
  a reusable artifact.
- **Scratchpad memory existed but was unnamed/undocumented** - two
  independent, correct implementations (`server/browserAgent.js`,
  `toolOrchestrator.js`) with no shared vocabulary connecting them or
  offering the pattern to a future third loop.

## What this pass wired up

1. **`src/services/memory/memoryTypes.js`** (new) - the taxonomy
   above, plus `ZAO_MEMORY_PROFILE` giving a one-line plain-language
   summary of each type, for a future Settings screen.
2. **`src/services/memory/workingMemory.js`** (new) -
   `buildWorkingHistory(conversationId, allMessages)`: below a
   character-budget threshold, behaves exactly as before (full raw
   history). Above it, keeps a verbatim recent tail and folds
   everything older into a rolling summary, extended incrementally
   (only newly-uncovered messages get summarized each time, not the
   whole conversation from scratch) and persisted per conversation.
3. **`src/services/memory/retrievalMemory.js`** (new) -
   `shouldAttemptRecall(userText)` is a local, no-LLM regex check for
   backward-reference phrasing ("remember when...", "we talked
   about..."); when it fires, `retrieveRelevantContext()` runs a
   BM25-lite lexical score over recent messages across EVERY
   conversation (excluding the current one) and returns the top
   matches as a system message, clearly labeled as "may or may not
   actually be what they mean."
4. **`src/services/memory/proceduralMemory.js`** (new) -
   `recordProcedure()` distills a successfully-completed hierarchical
   plan's steps into a reusable recipe; `findSimilarProcedure()` /
   `withProceduralHint()` look one up by token-overlap against a new
   goal and fold a short "here's what worked before" note straight
   into the goal text handed to the planners.
5. **`src/services/memory/scratchpad.js`** (new) - names the pattern
   already implemented independently in `server/browserAgent.js` and
   `toolOrchestrator.js`, and offers a shared, correctly-bounded
   `Scratchpad` class for any future agent loop. The two existing
   implementations were left as-is (only a doc-comment pointer added
   at each) rather than force-refactored, to avoid destabilizing two
   already-working agent loops for no functional gain.
6. **`src/db/database.js`** - new `procedures` table (procedural
   memory); `conversations.rolling_summary` /
   `rolling_summary_covers_at` columns (working-memory compaction,
   idempotent migration, same pattern as every other column added
   post-launch); `getRecentMessagesAcrossConversations()` (retrieval
   memory's search pool); full CRUD for all of the above.
7. **`src/store/chatStore.js`** - all three history-build call sites
   (send / edit / regenerate) now go through one shared
   `assembleHistory()` helper, layering semantic facts → feedback
   guidance → retrieved snippets → rolling summary → raw recent turns,
   in that fixed order, instead of each hand-rolling its own
   `unshift()` calls.
8. **`src/services/planning/planExecutor.js`** - on a clean plan
   completion (not a failed/blocked one), fire-and-forget calls
   `recordProcedure()` with the plan's goal and step list.
9. **`src/services/brain/backendBrain.js`** - `runHierarchicalPlan()`
   calls `withProceduralHint()` on the incoming goal text before
   handing it to `planCoordinator.buildPlan()`.

## Later addition: feedback memory

A separate, later pass added `src/services/memory/feedbackMemory.js` -
dislikes on assistant messages (`messages.feedback`, thumbs-down button)
are distilled into general "avoid this" instructions and aggregated by
similarity, then injected into `assembleHistory()` alongside the
semantic-memory block. This isn't one of the seven types in the table
above (it's closer to a negative counterpart of procedural memory - "how
NOT to do X" rather than "how to do X" - distilled from feedback rather
than from a successful run). Full writeup, including what was broken
before and why likes aren't mirrored the same way, is in
`SYSTEM_COMPONENTS.md`'s "Feedback loop / learning signal" section.

## Later addition: prospective memory gets a ZAO-owned store

Previously the PROSPECTIVE row in the table above was the one type with
no real ZAO-side plumbing: "remind me to X" was handed straight to
Android's AlarmManager (via expo-notifications) and forgotten - there
was no `reminders` table, so ZAO could not list what it had scheduled,
tell the person whether a reminder actually took (vs. silently failing
because notification permission was denied), or cancel one without the
person digging through the system notification shade.

`src/services/reminders/reminderService.js` + the `reminders` table
(`src/db/database.js`) fix this with the same ownership inversion the
rest of this file's memory types already use: the SQLite row is the
source of truth ZAO reads from and reasons about; expo-notifications is
the delivery mechanism *underneath* it, not the only record. Every
schedule/cancel writes the DB row first, then best-effort mirrors it
into the OS - if the OS-level call fails, the row still exists and says
`status: 'failed'` instead of the reminder just vanishing with no
trace. `reconcileReminders()` runs once at app startup (`App.js`,
alongside `initDatabase()`) and sweeps any reminder whose `trigger_at`
has already passed without ZAO having heard a delivered/tapped event
for it, so the table can't get stuck claiming something is still
"scheduled" long after its time has come and gone.

Repeating reminders (`repeat_rule: 'daily' | 'weekly'`, no general
RRULE) are implemented as a chain of one-shot triggers rather than
depending on expo-notifications' own repeating-trigger types, whose
exact shape has shifted across SDK versions: when one occurrence fires,
the next is inserted as a new row and scheduled fresh. A few more rows
over time, but every occurrence stays individually inspectable and
cancelable, and the whole thing is immune to a trigger-type API change
underneath it.

Exposed to the model as three tools in `toolOrchestrator.js`:
`reminder_create`, `reminder_list`, `reminder_cancel` -
`source_conversation_id` is always taken from the caller's own
`conversationId` context (never a model-supplied argument), the same
security pattern already used for `agent_create_worktree`'s
`sourceConversationId`.

Also gets a Settings > Reminders section (`SettingsScreen.js`'s
`RemindersSection`, same shape as the existing Memory section) listing
every reminder regardless of status, with Cancel (for still-pending
ones) and Remove (to forget a completed/cancelled/failed one) - so this
is inspectable/cancelable from the app itself, not only through the
chat tool-calling path or the system notification shade.

## Later addition: procedural memory reaches the flat tool loop

Procedural memory (see "What this pass wired up" above) originally
plugged in at exactly one call site: `backendBrain.js`'s
`runHierarchicalPlan()`, via `withProceduralHint()`, right before
building a Strategic/Project/Task/Execution plan tree. The flat ReAct
loop (`toolOrchestrator.js`'s `runToolTask` - the `TOOL_EXECUTOR` brain
role, used for requests that don't need the full hierarchical plan)
never checked procedural memory at all - the two loops read the same
`procedures` table's existence in `memoryTypes.js`, but only one of
them actually looked before starting.

`runToolTask` now does both sides, automatically, on every call - no
flag, no opt-in:

- **Read, self-triggered:** before building its initial history, it
  calls `withProceduralHintReported()` (a new variant of
  `withProceduralHint()` that also reports back whether a match was
  applied, so the reuse can be surfaced rather than silently folded into
  the prompt) and, if something matched, both folds the hint into the
  model's copy of the request and adds a step to the live checklist -
  `Recognized a similar past task ("...") - reusing that approach` -
  so the person can see it happened, not just infer it from faster/more
  consistent results.
- **Write:** on a successful finish (a final answer with at least one
  successful tool call along the way), it calls `recordProcedure()`
  itself, the same function `planExecutor.js` calls for a completed
  hierarchical plan - there's no separate "executor" module for the
  flat loop, so `runToolTask` is both the thing that runs the steps and
  the thing that remembers them. Steps are tagged with a coarse
  `domain` (`domainForTool()` - github/filesystem/terminal/pdf/office/
  search/data/reminders/agent/general) so they're shaped the same as a
  hierarchical plan's own step domains and land in one shared bank
  either loop can draw from.

Because both loops read and write the same `procedures` table, a
procedure recorded by a quick flat-loop request can turn up as a hint
the next time a similar goal is big enough to go through the
hierarchical planner instead, and vice versa - the bank doesn't care
which loop produced an entry, only whether a new goal resembles it.

`withProceduralHint()` (the original, still used by `backendBrain.js`)
now also bumps the matched procedure's `use_count` when a hint is
actually applied, not only when `recordProcedure()`'s own internal dedup
logic treats a new run as a near-duplicate of an existing one - so
`use_count` now reflects real reuse on both paths, not just re-recording.

## What still needs work (not done in this pass)

- **Retrieval memory has no re-ranking or dedup against what
  `memoryEngine.js` already injected.** A snippet retrieval surfaces
  could, in principle, restate something the semantic-memory block
  already says. Low-frequency enough in practice (retrieval only fires
  on explicit backward-reference phrasing, semantic memory is always
  short facts not full exchanges) that it wasn't worth the extra
  complexity this pass, but worth revisiting if it turns out to be
  noisy in daily use.
- **No Settings UI for procedures.** `procedures` has full CRUD
  (`addProcedure`/`getAllProcedures`/`bumpProcedureUsage`/
  `deleteProcedure`) but nothing in `SettingsScreen.js` lists or lets
  the person delete a learned procedure yet, unlike the existing
  Settings > Memory screen for semantic facts.
- **Working-memory char budgets are a rough estimate, not real
  tokenization.** Character count / 4 ≈ tokens is a safe-enough
  approximation for "should I compact yet?" but isn't exact - fine for
  now since the thresholds have generous headroom either way.
