/**
 * ZAO's Memory Taxonomy
 *
 * Companion to src/services/brain/brainTypes.js - that file classifies
 * ZAO's model ARCHITECTURE (dense/MoE/ensemble/hybrid); this file
 * classifies its MEMORY (what persists, for how long, and where).
 * MEMORY_ARCHITECTURE.md at the repo root is the prose map of what got
 * wired up and where; this is the machine-readable version of the same
 * classification.
 *
 * A memory system is really a small handful of independent design axes:
 *   - WHERE it lives (model weights vs. this run's RAM vs. SQLite on disk)
 *   - HOW LONG it lasts (one inference, one run, one conversation, forever)
 *   - WHAT it's derived from (raw transcript vs. an extracted fact vs. a
 *     distilled procedure)
 *   - WHO/WHAT reads it (the same run only, every future conversation,
 *     a search over history)
 * Every entry below names those axes explicitly rather than just giving
 * a label, because "memory" is used loosely enough in casual conversation
 * that the label alone doesn't tell you much.
 */

export const MEMORY_TYPES = Object.freeze({
  PARAMETRIC: {
    key: 'parametric',
    label: 'Parametric memory',
    definition: 'Knowledge baked into the model\'s weights during training - not retrieved, not written to, just... known, the same way a person "just knows" their native language\'s grammar without consulting a rulebook.',
    persistence: 'Forever (until the model is retrained/fine-tuned) - nothing at runtime changes it.',
    zaoImplementation: 'The Qwen model\'s own training - runs on the PC-hosted llama-server (see server/ and src/services/backend/backendClient.js). Nothing in this app writes to it; every other memory type below exists BECAUSE this one is fixed and can\'t learn anything new about the person at runtime.',
    location: 'backend (the model weights themselves, wherever llama-server loads them from)',
  },

  CONTEXT_WINDOW: {
    key: 'context_window',
    label: 'Context window / working memory (raw)',
    definition: 'The current conversation as literally sent to the model this turn - gone the instant the call returns unless something else persists it.',
    persistence: 'One model call. Rebuilt fresh every turn from whatever\'s in SQLite plus the new message.',
    zaoImplementation: 'src/store/chatStore.js assembles `history` for every send/edit/regenerate call. As of this pass, workingMemory.js sits between chatStore.js and backendClient.sendMessage() to keep this bounded on long conversations (see WORKING_MEMORY_COMPACTION below) instead of always sending the full transcript.',
    location: 'frontend (assembled on-device, sent to backend per call)',
  },

  WORKING_MEMORY_COMPACTION: {
    key: 'working_memory_compaction',
    label: 'Working-memory compaction (rolling summary)',
    definition: 'Not a separate memory type in the classic taxonomy, but a real mechanism needed to make CONTEXT_WINDOW behave well once a conversation outgrows a comfortable prompt size: older turns are condensed into one running summary, kept turns stay verbatim.',
    persistence: 'Per conversation, forever (until that conversation is deleted) - the summary text itself lives in SQLite, not just this run.',
    zaoImplementation: 'src/services/memory/workingMemory.js. conversations.rolling_summary / rolling_summary_covers_at columns in src/db/database.js. Was NOT implemented before this pass - chatStore.js sent full history unconditionally.',
    location: 'frontend logic + local SQLite; the summarization call itself goes to whichever backend is configured',
  },

  EPISODIC: {
    key: 'episodic',
    label: 'Episodic memory',
    definition: 'Persisted records of specific past interactions - the raw "what actually happened" transcript, tied to a specific time and conversation.',
    persistence: 'Forever (until the person deletes the conversation) - this is the most durable, least processed memory type ZAO has.',
    zaoImplementation: 'src/db/database.js `conversations` + `messages` tables. Every plan run\'s step-by-step trace (plan_steps, plan_step_actions - the literal reasoning + tool-call + result sequence) is also episodic in this sense: a record of one specific run, not a generalized fact or method.',
    location: 'frontend (SQLite, on-device, never leaves the phone except in an outbound prompt)',
  },

  SEMANTIC: {
    key: 'semantic',
    label: 'Semantic memory',
    definition: 'Persisted general facts/preferences extracted FROM episodes but no longer tied to any one of them - "User lives in Lagos" survives independent of which specific conversation that came up in.',
    persistence: 'Forever (until edited/forgotten) - deliberately outlives the conversation it was extracted from (source_conversation_id is nullable, ON DELETE SET NULL).',
    zaoImplementation: 'src/services/memory/memoryEngine.js + the `memories` table. Three mechanisms: buildMemoryContextBlock() (inject), extractMemoriesFromTurn() (background extraction), detectExplicitMemoryCommand() (instant "remember this"/"forget that"). This is the type most people mean when they say "Claude/ChatGPT\'s memory."',
    location: 'frontend (SQLite) - extraction calls the configured backend, storage/retrieval is 100% local',
  },

  PROCEDURAL: {
    key: 'procedural',
    label: 'Procedural memory',
    definition: '"How to do X" - in a base LLM this genuinely isn\'t separable from PARAMETRIC (a model doesn\'t have a distinct "procedures" store; competence is just weights). What ZAO adds is a lightweight ANALOGUE outside the model: a persisted record of one specific ordered tool-sequence that worked for a real past goal, retrievable as a hint for a similar future goal.',
    persistence: 'Forever (until deleted) - reinforced (use_count bumped) rather than duplicated when a similar goal recurs.',
    zaoImplementation: 'src/services/memory/proceduralMemory.js + the `procedures` table, shared by two independent producers/consumers: the hierarchical planner (src/services/planning/planExecutor.js writes on a completed plan; src/services/brain/backendBrain.js reads via withProceduralHint() before building a new plan) and, as of a later pass, the flat ReAct loop (src/services/toolOrchestrator.js\'s runToolTask reads via withProceduralHintReported() before every request and writes back its own successful runs via recordProcedure()) - self-triggered on both sides, no explicit ask needed, and a procedure recorded by either loop can be matched and reused by the other.',
    location: 'frontend (SQLite) - lookup/storage local; the planning calls it feeds into go to the configured backend',
  },

  RETRIEVAL: {
    key: 'retrieval',
    label: 'Vector / retrieval memory',
    definition: 'Embeddings + similarity search over a knowledge base (RAG-style) - broader recall than what fits in the context window or the semantic-fact bank, found by searching rather than always-on injection.',
    persistence: 'As durable as the underlying data (messages table) - this type doesn\'t store anything new itself, it searches what EPISODIC memory already persisted.',
    zaoImplementation: 'src/services/memory/retrievalMemory.js. No embedding model runs locally (too heavy for a phone) - this is a lexical BM25-lite scorer over src/db/database.js\'s getRecentMessagesAcrossConversations(), playing the same functional role for this app\'s actual use case (recalling something from an old, closed conversation) without the weight of a real vector index. Triggered locally (shouldAttemptRecall(), no LLM call) only when the message itself looks like a backward reference ("remember when...", "we talked about..."). The project\'s much earlier ZenosNet/Python phase (see BRAIN_ARCHITECTURE.md\'s history) used real BM25 over a bigger corpus for a different, now-retired architecture; this is the equivalent for the current React Native app.',
    location: 'frontend (SQLite scan + local scoring, no network, no model call unless a match needs summarizing)',
  },

  SCRATCHPAD: {
    key: 'scratchpad',
    label: 'Scratchpad / short-term working memory',
    definition: 'Explicit intermediate reasoning kept only for the current task - an agent\'s step history within one run, discarded the moment the run ends. Chain-of-thought within a single agent loop.',
    persistence: 'One run only. Never written to disk, never reused by a different run.',
    zaoImplementation: 'Two existing implementations, independent (see src/services/memory/scratchpad.js for the shared pattern documented for future use): server/browserAgent.js\'s `BrowserAgentSession.history` (PC-side Playwright agent loop, with its own observation-trimming already built in), and src/services/toolOrchestrator.js\'s local `history` array (phone-side flat ReAct tool loop). Both pre-date this pass and were left as-is rather than force-refactored.',
    location: 'backend for the browser agent (server/browserAgent.js runs on the PC); frontend for the flat tool loop (toolOrchestrator.js runs on-device)',
  },

  // ---- Beyond the original seven - patterns ZAO already has tool-level
  // support for, or that are worth naming even where "add a whole new
  // subsystem" isn't the right amount of engineering for what they need. ----

  PROSPECTIVE: {
    key: 'prospective',
    label: 'Prospective memory',
    definition: 'Remembering to do something in the FUTURE, at a specific time or trigger - distinct from all the above, which are about recalling the past. "Remind me to check the broiler feeders at 6am."',
    persistence: 'Until the reminder fires or is cancelled - the `reminders` row persists across that whole lifecycle regardless of what the OS scheduler does underneath it.',
    zaoImplementation: 'src/services/reminders/reminderService.js + the `reminders` table in src/db/database.js. The ZAO-owned table is now the source of truth; Android\'s AlarmManager (via expo-notifications) is a best-effort mirror underneath it, not the only record - a reminder ZAO scheduled is inspectable and cancelable from inside the app (reminder_list/reminder_cancel tools) even if the OS-level notification silently failed to schedule (e.g. permission denied), because the DB row says so honestly instead of the reminder just vanishing with no trace.',
    location: 'frontend (SQLite is the source of truth) + device OS (expo-notifications mirrors it for actual delivery)',
  },

  PROVENANCE: {
    key: 'provenance',
    label: 'Provenance / source memory',
    definition: 'Metadata about WHERE a piece of memory came from, not the fact/content itself - lets a memory be traced back, audited, or selectively invalidated if its source turns out to be wrong.',
    persistence: 'As long as the memory it\'s attached to.',
    zaoImplementation: 'memories.source_conversation_id (memoryEngine.js), procedures.source_plan_id (proceduralMemory.js), plan_step_actions\' reasoning-vs-tool-call interleaving (planExecutor.js). Not a separate store - a column pattern applied consistently across the other stores above.',
    location: 'frontend (SQLite - riding along on the same tables as EPISODIC/SEMANTIC/PROCEDURAL)',
  },
});

/**
 * One paragraph per type, keyed the same as MEMORY_TYPES, purely so
 * MEMORY_ARCHITECTURE.md and any future Settings > "About ZAO's memory"
 * screen can render a plain-language summary without duplicating prose
 * that already lives in the JSDoc above.
 */
export const ZAO_MEMORY_PROFILE = Object.freeze({
  parametric: 'What the model already knows from training - not something ZAO manages.',
  contextWindow: 'This turn\'s conversation, sent fresh every time.',
  workingMemoryCompaction: 'Long conversations get condensed automatically so they never overflow.',
  episodic: 'Every conversation and every plan run, kept verbatim in SQLite, forever.',
  semantic: 'Durable facts about you, extracted automatically or by direct command, re-injected into every new conversation.',
  procedural: 'Task recipes ZAO learned worked before, automatically checked and offered as a hint before starting a similar future task - no need to ask.',
  retrieval: 'Local keyword search across ALL past conversations, triggered when you reference something from before.',
  scratchpad: 'An agent\'s in-the-moment reasoning trail for one run - never saved.',
  prospective: 'Reminders ZAO scheduled, tracked in its own store and inspectable/cancelable from within the app - not just handed off to the device and forgotten.',
  provenance: 'Every stored memory/procedure knows which conversation or plan it came from.',
});
