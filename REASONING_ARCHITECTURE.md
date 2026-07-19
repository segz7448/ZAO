# ZAO's Reasoning Architecture

Full taxonomy + ZAO's classification against it lives in
`src/services/reasoning/reasoningTypes.js` (read that first - this file
is just a map of what got wired up and where). This doc is
`BRAIN_ARCHITECTURE.md`'s sibling: that file is about what the MODEL is
(dense transformer, multi-role ensemble, hybrid symbolic-neural). This
one is about how a single turn actually REASONS its way to an answer.

## The reasoning strategies

| Strategy | What it means | Does ZAO use it? |
|---|---|---|
| Chain-of-thought (CoT) | Linear step-by-step reasoning before an answer | **Yes** - the default for plain chat. `src/services/reasoning/chainOfThought.js` |
| Tree-of-thought / branching search | Multiple candidate approaches, critiqued and selected (or backtracked) | **Yes** - `src/services/reasoning/treeOfThought.js` |
| ReAct (Reason + Act) | Interleaves reasoning with real tool calls and observations | **Yes** - already existed as `src/services/toolOrchestrator.js`'s tool_calls loop and `server/browserAgent.js`'s plan/act/observe loop; this pass names and tags it |
| Self-reflection / self-critique | Reviews and revises its own prior output | **Yes** - `src/services/reasoning/selfReflection.js`, triggered automatically per-reply (not a setting) by `reasoningEngine.js`'s `shouldAutoReflect()` |
| Deductive | General rule -> specific conclusion | **Yes** - `src/services/reasoning/inferenceModes.js` (`runDeductive`) |
| Inductive | Specific examples -> general rule | **Yes** - `inferenceModes.js` (`runInductive`) |
| Abductive | Best-guess explanation from incomplete evidence (debugging) | **Yes** - `inferenceModes.js` (`runAbductive`); local regex catches debugging-shaped language before ever calling the model |
| Analogical | Reasoning by mapping to a known, structurally similar situation | **Yes** - `inferenceModes.js` (`runAnalogical`) |
| Hybrid symbolic plan | The Strategic->Project->Task->Execution planning tree | **Yes**, pre-existing (`src/services/planning/`) - cross-referenced here only so the chat reasoning chip can label it consistently |

Every strategy is orchestration around ZAO's one Qwen2.5-Coder-3B model
(one or more structured calls, parsed results) - none of them are a
claim that the model itself natively branches, self-plays, or reflects
in a single forward pass. Per the person's own framing this mirrors
Claude: CoT and ReAct patterns show up depending on the task (extended
thinking = explicit CoT, tool-use loops = ReAct), while branching search
and self-reflection are things a harness built around the model does,
not something the model does natively.

**By design, none of this is manual.** Strategy selection
(`reasoningRouter.js`) and the self-reflection pass
(`reasoningEngine.js`'s `shouldAutoReflect()`) are both decided from the
message/answer itself, with no Settings toggle and no per-message
override. This follows the same principle every other routing decision
in the app already uses (`frontendBrain.js` picks BRAIN_ROUTES the same
way) - the app reads the request and decides, rather than asking the
person to know a setting exists and remember to flip it.

## What was already built vs. what this pass added

Before this pass, ZAO had exactly two reasoning shapes, both unnamed as
such:
- **ReAct**, twice over - `toolOrchestrator.js`'s flat tool-calling loop
  and `browserAgent.js`'s live browser loop.
- **Chain-of-thought**, implicitly - every plain-chat message got one
  bare completion call with no explicit "think step by step" framing,
  no branching, no self-check, and no distinction between e.g. a
  debugging question and a design question.
- The **hybrid symbolic plan** (`src/services/planning/`) existed and
  was wired to chat (see `BRAIN_ARCHITECTURE.md`'s own "what was already
  built" section from the prior pass).

Six reasoning shapes did not exist anywhere: tree-of-thought,
self-reflection, deductive, inductive, abductive, and analogical.

## What this pass wired up

1. **`src/services/reasoning/reasoningTypes.js`** (new) - the taxonomy
   above, plus `REASONING_PROFILE` naming exactly which file implements
   which strategy, mirroring `brainTypes.js`'s `ZAO_BRAIN_PROFILE`
   pattern.
2. **`src/services/reasoning/chainOfThought.js`** (new) - explicit CoT:
   `<thinking>`/`<answer>` tags, one call. Also exports
   `withSystemPrompt`/`splitThinkingAndAnswer`, reused by
   `inferenceModes.js` and `treeOfThought.js`.
3. **`src/services/reasoning/treeOfThought.js`** (new) - generate 3
   branches -> critique/select -> one backtrack-and-regenerate if every
   branch is judged weak. Two model calls in the common case.
4. **`src/services/reasoning/selfReflection.js`** (new) - critique the
   draft, revise only if the critique actually found something.
5. **`src/services/reasoning/inferenceModes.js`** (new) - deductive,
   inductive, abductive, analogical, each its own explicit system
   prompt + the same `<thinking>`/`<answer>` contract as CoT.
6. **`src/services/reasoning/reasoningRouter.js`** (new) -
   `decideReasoningStrategy(messageText)`: free local regex for
   abductive/analogical, one classifier model call for everything else,
   CoT as the safe fallback if the classifier call fails.
7. **`src/services/reasoning/reasoningEngine.js`** (new) -
   `runReasoningChat(history, messageText)`, the dispatcher
   `orchestrator.js` calls: routes, runs the chosen strategy, and layers
   self-reflection on top automatically when `shouldAutoReflect()`
   flags the reply as worth double-checking - a correctness-sensitive
   strategy (deductive/abductive), code/calculation content in the
   draft, or explicit "double check this" language in the request. Not
   a person-facing setting: whether an answer deserves a second look is
   a property of the answer, not a standing preference. Always skipped
   for tree-of-thought, which already carries its own critique step.
   Falls back to one plain completion if the chosen strategy fails
   outright. Also exports `STRATEGY_FOR_ROUTE`, the label map for routes
   that had their own reasoning shape before this pass (ReAct for
   tool/browsing, hybrid symbolic plan for the hierarchical planner).
8. **`src/utils/orchestrator.js`** - the plain-chat branch now calls
   `runReasoningChat()` instead of a bare `backendClient.sendMessage()`;
   the tool-task, browsing, and hierarchical-plan branches now tag their
   replies with `reasoningType` via `STRATEGY_FOR_ROUTE` so every kind of
   reply carries a label, not just chat ones.
9. **`src/db/database.js`** - `reasoning_type` / `reasoning_trace`
   columns on `messages` (idempotent migration, same pattern as
   `plan_id`).
10. **`src/store/chatStore.js`** - `buildAssistantMessageFromResult()`
    (the one helper all three send/edit/regenerate paths already share)
    now threads `reasoning_type`/`reasoning_trace` through to the
    persisted message, same as it already did for `plan_id`.
11. **`src/screens/ChatScreen.js`** - a new `ReasoningChip` component:
    a small "→ Chain of thought" / "⑂ Tree of thought" / etc. chip under
    every assistant reply that has a `reasoning_type`, tap to
    expand/collapse the recorded trace (branches considered, critique,
    the `<thinking>` block - whatever that strategy recorded).
12. **`src/services/brain/backendBrain.js`** - added the `REASONER` role
    to `BRAIN_ROLES` and updated `CONVERSATIONALIST`'s description, since
    plain chat no longer means "one bare completion call."

## What still needs work (not done in this pass)

- **Tree-of-thought branch count**: fixed at 3
  (`treeOfThought.js`'s `BRANCH_COUNT`), not adjustable per-request.
- **Reasoning trace on regenerate**: regenerating a reply re-runs
  `runReasoningChat()` fresh (the router may pick a different strategy
  on a re-roll) rather than reusing the prior trace - this is
  intentional (a regenerate should get a genuinely fresh attempt), just
  noting it's not "regenerate keeps the same reasoning shape."
- **MoE-style honesty carried over**: none of this claims the 3B model
  itself does native branching/reflection - see `reasoningTypes.js`'s
  header for why that distinction matters and mirrors how Claude itself
  is described.
