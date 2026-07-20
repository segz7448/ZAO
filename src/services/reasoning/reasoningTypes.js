/**
 * ZAO - Reasoning Architecture Taxonomy
 *
 * This is brainTypes.js's sibling: that file names the four ways the
 * MODEL is put to work (dense transformer, MoE, multi-brain ensemble,
 * hybrid symbolic-neural). This file names the ways a single model call
 * (or short sequence of them) actually REASONS toward an answer, and
 * pins down which of those strategies ZAO implements, where, and which
 * BRAIN_ROLE(s) each one calls through.
 *
 * Nothing in here executes anything - see reasoningRouter.js for the
 * routing decision and reasoningEngine.js for the dispatcher that
 * actually runs a strategy.
 *
 * ============================================================
 * THE REASONING STRATEGIES
 * ============================================================
 *
 * 1. CHAIN_OF_THOUGHT (CoT)
 *    Linear step-by-step reasoning before an answer. One model call:
 *    "think it through, then answer." ZAO's default for ordinary chat.
 *
 * 2. TREE_OF_THOUGHT (ToT) / branching search
 *    Generates multiple distinct candidate approaches, critiques them
 *    against each other, and selects (or backtracks and regenerates)
 *    rather than committing to the first line of reasoning. Used for
 *    open-ended / ambiguous / "more than one reasonable way to do this"
 *    requests.
 *
 * 3. REACT (Reason + Act)
 *    Interleaves reasoning with real tool calls and observations of
 *    their results. ZAO already had this before this pass -
 *    toolOrchestrator.js's tool_calls loop and browserAgent.js's
 *    plan/act/observe loop both ARE ReAct, they just weren't named as
 *    such. This module documents that mapping rather than duplicating
 *    the loop.
 *
 * 4. SELF_REFLECTION / self-critique
 *    The model reviews its own prior output against the original
 *    request, flags problems, and revises if needed. A second pass
 *    layered on top of any other strategy's output, not a strategy
 *    that stands alone.
 *
 *    Sibling, not listed as its own numbered strategy here since it
 *    doesn't produce a person-facing ANSWER the way 1-9 do: actionConfidence.js
 *    (runs from toolOrchestrator.js's tool loop) is the same
 *    critique-pass shape pointed the other direction in time - instead
 *    of reviewing a draft answer after it's written, it rates
 *    confidence in a tool call immediately BEFORE it executes, and only
 *    for calls a permission mode is about to let run with no human
 *    confirmation. Low confidence there converts that specific call into
 *    a confirmation card rather than letting the mode's "auto-run"
 *    setting run it silently.
 *
 * 5. DEDUCTIVE
 *    General rule(s) -> specific conclusion. "Given X is always true,
 *    and this case is an instance of X, therefore Y."
 *
 * 6. INDUCTIVE
 *    Specific examples/evidence -> general rule. "These N cases all
 *    show pattern P, so P probably holds generally" - held with
 *    appropriate uncertainty, unlike deduction's certainty.
 *
 * 7. ABDUCTIVE
 *    Best-guess explanation from incomplete evidence - the shape of
 *    real debugging: given a symptom (an error, a failure, a partial
 *    description), generate plausible causes, weigh them against the
 *    evidence available, and commit to the best-supported one.
 *
 * 8. ANALOGICAL
 *    Reasoning by mapping a new situation onto a structurally similar
 *    known one, then carrying the known situation's logic across the
 *    mapping - explicit about where the analogy holds and where it
 *    breaks down.
 *
 * 9. HYBRID_SYMBOLIC_PLAN
 *    Not a "reasoning style" in the same sense as 1-8 - this is
 *    brainTypes.js's HYBRID_SYMBOLIC_NEURAL architecture
 *    (src/services/planning/), listed here only so reasoningRouter.js's
 *    routing table is complete: a goal big enough to need the full
 *    Strategic->Project->Task->Execution tree was already being routed
 *    there before this pass (frontendBrain.js), it just wasn't labeled
 *    alongside the other reasoning strategies. No new code - this is a
 *    cross-reference, not an implementation.
 *
 * ============================================================
 * WHERE CLAUDE ITSELF SITS
 * ============================================================
 * Per the person's own framing: Claude uses CoT and ReAct-style
 * patterns depending on the task (extended thinking mode is explicit
 * CoT; tool-use loops are ReAct) - it doesn't natively do tree-search
 * or true self-play reasoning; that structure, when it exists, lives in
 * the product surface around the model (e.g. an agent harness choosing
 * to branch, critique, and pick), not in the model's own weights or a
 * single forward pass. ZAO's reasoning layer mirrors that: every
 * strategy below is built as ORCHESTRATION around the one Qwen2.5-Coder-3B
 * model (one or more calls, structured prompts, parsed results) - never
 * a claim that the model itself natively branches or self-plays.
 */

export const REASONING_STRATEGIES = Object.freeze({
  CHAIN_OF_THOUGHT: 'chain_of_thought',
  TREE_OF_THOUGHT: 'tree_of_thought',
  REACT: 'react',
  SELF_REFLECTION: 'self_reflection',
  DEDUCTIVE: 'deductive',
  INDUCTIVE: 'inductive',
  ABDUCTIVE: 'abductive',
  ANALOGICAL: 'analogical',
  HYBRID_SYMBOLIC_PLAN: 'hybrid_symbolic_plan',
});

/** Human-readable labels - used by ChatScreen.js's reasoning chip and any future "why did ZAO answer this way" surface. */
export const REASONING_STRATEGY_LABELS = Object.freeze({
  [REASONING_STRATEGIES.CHAIN_OF_THOUGHT]: 'Chain of thought',
  [REASONING_STRATEGIES.TREE_OF_THOUGHT]: 'Tree of thought',
  [REASONING_STRATEGIES.REACT]: 'Reason + act (ReAct)',
  [REASONING_STRATEGIES.SELF_REFLECTION]: 'Self-reflection',
  [REASONING_STRATEGIES.DEDUCTIVE]: 'Deductive reasoning',
  [REASONING_STRATEGIES.INDUCTIVE]: 'Inductive reasoning',
  [REASONING_STRATEGIES.ABDUCTIVE]: 'Abductive reasoning',
  [REASONING_STRATEGIES.ANALOGICAL]: 'Analogical reasoning',
  [REASONING_STRATEGIES.HYBRID_SYMBOLIC_PLAN]: 'Hierarchical plan',
});

/** Short icon-adjacent glyphs for the chat chip - no icon font dependency, just a small readable mark. */
export const REASONING_STRATEGY_GLYPHS = Object.freeze({
  [REASONING_STRATEGIES.CHAIN_OF_THOUGHT]: '→',
  [REASONING_STRATEGIES.TREE_OF_THOUGHT]: '⑂',
  [REASONING_STRATEGIES.REACT]: '⚙',
  [REASONING_STRATEGIES.SELF_REFLECTION]: '↺',
  [REASONING_STRATEGIES.DEDUCTIVE]: '⊢',
  [REASONING_STRATEGIES.INDUCTIVE]: '≈',
  [REASONING_STRATEGIES.ABDUCTIVE]: '?',
  [REASONING_STRATEGIES.ANALOGICAL]: '↔',
  [REASONING_STRATEGIES.HYBRID_SYMBOLIC_PLAN]: '☰',
});

/**
 * ZAO's classification against the taxonomy above - mirrors
 * brainTypes.js's ZAO_BRAIN_PROFILE pattern exactly.
 */
export const REASONING_PROFILE = Object.freeze({
  [REASONING_STRATEGIES.CHAIN_OF_THOUGHT]: {
    implemented: true,
    where: 'src/services/reasoning/chainOfThought.js (runChainOfThought) - the default strategy for plain chat.',
  },
  [REASONING_STRATEGIES.TREE_OF_THOUGHT]: {
    implemented: true,
    where: 'src/services/reasoning/treeOfThought.js (runTreeOfThought) - branch/critique/select, one backtrack-and-regenerate pass if every branch is judged weak.',
  },
  [REASONING_STRATEGIES.REACT]: {
    implemented: true,
    where: 'src/services/toolOrchestrator.js (runToolTask - the flat tool_calls loop) and server/browserAgent.js (the live browser plan/act/observe loop). Pre-existing; this pass only labels and taps it for reasoning_type tagging (see reasoningEngine.js).',
  },
  [REASONING_STRATEGIES.SELF_REFLECTION]: {
    implemented: true,
    where: 'src/services/reasoning/selfReflection.js (runSelfReflection) - an optional second pass over any other strategy\'s draft answer, triggered automatically by reasoningEngine.js\'s shouldAutoReflect() (correctness-sensitive strategy, code/calculation content, or an explicit "double check this" request) - not a person-facing setting, since it doubles latency and should only fire when the reply actually calls for it.',
  },
  [REASONING_STRATEGIES.DEDUCTIVE]: {
    implemented: true,
    where: 'src/services/reasoning/inferenceModes.js (runDeductive)',
  },
  [REASONING_STRATEGIES.INDUCTIVE]: {
    implemented: true,
    where: 'src/services/reasoning/inferenceModes.js (runInductive)',
  },
  [REASONING_STRATEGIES.ABDUCTIVE]: {
    implemented: true,
    where: 'src/services/reasoning/inferenceModes.js (runAbductive) - the debugging-shaped one; reasoningRouter.js\'s local heuristic (error/stack-trace/"not working" phrasing) routes here before ever calling the model, since this pattern is cheap and reliable to catch without a classifier round trip.',
  },
  [REASONING_STRATEGIES.ANALOGICAL]: {
    implemented: true,
    where: 'src/services/reasoning/inferenceModes.js (runAnalogical)',
  },
  [REASONING_STRATEGIES.HYBRID_SYMBOLIC_PLAN]: {
    implemented: true,
    where: 'src/services/planning/ + src/services/brain/backendBrain.js (runHierarchicalPlan) - pre-existing, cross-referenced here only so the reasoning chip can label a plan-originated reply consistently with everything else (see reasoningEngine.js\'s STRATEGY_FOR_ROUTE).',
  },
});
