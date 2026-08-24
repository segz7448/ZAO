/**
 * ZAO - Brain Architecture Taxonomy
 *
 * This file is documentation-as-code: it names the four ways an AI
 * agent's "brain" (its model architecture + how that model is actually
 * put to work) can be built, and pins down exactly which of them ZAO
 * uses, where, and why. Nothing in here executes anything - it's the
 * map frontendBrain.js and backendBrain.js are drawn on, the same role
 * planTypes.js plays for the planning system.
 *
 * ============================================================
 * THE FOUR BRAIN TYPES (model architecture / role)
 * ============================================================
 *
 * 1. DENSE TRANSFORMER
 *    One network. Every parameter is active on every token. Simplest,
 *    most predictable, cheapest to reason about - what many open-weight
 *    models are. Unknown whether this is ZAO's own model - see #2 below.
 *
 * 2. MIXTURE-OF-EXPERTS (MoE)
 *    Many sub-networks ("experts") behind a gate; only a handful are
 *    active per token. Lets a model reach a much larger total parameter
 *    count while keeping per-token inference compute closer to a dense
 *    model of the "active" size. ZAO's own model, Ox Alpha (an anonymous
 *    stealth-preview model served via OpenRouter), doesn't publish which
 *    of #1 or #2 it actually is - see localModels.js's header comment
 *    and ZAO_BRAIN_PROFILE below.
 *
 * 3. MULTI-BRAIN / ENSEMBLE
 *    Separate MODELS for separate roles - e.g. a small router model
 *    deciding what to do, handing off to a larger specialist model to
 *    actually do it. ZAO's variant of this is deliberately constrained:
 *    there is only ever ONE underlying model (Ox Alpha, served via
 *    OpenRouter and relayed by the VM backend - see
 *    src/config/localModels.js). "Multi-brain"
 *    here means multiple ROLES, each with its own system prompt,
 *    temperature, and job, all calling that one model - a router role,
 *    a planner role (in fact eight of them, see planTypes.js's 8
 *    planning concerns), an executor role, a recovery role. Same model,
 *    different hats. See backendBrain.js's BRAIN_ROLES.
 *
 * 4. HYBRID SYMBOLIC-NEURAL
 *    A neural net bolted onto a rules/logic engine - the neural side
 *    makes judgment calls, the symbolic side enforces structure,
 *    determinism, and guarantees the neural side can't. ZAO's planning
 *    system (src/services/planning/) is exactly this: planTypes.js's
 *    plan hierarchy, planExecutor.js's dependency-graph scheduler,
 *    riskClassifier.js's approval gating, and the plans/plan_steps
 *    SQLite schema are all deterministic, non-neural code - the "rules
 *    engine" half. The model is only ever asked narrow, structured
 *    questions inside that scaffold ("what are this task's steps?",
 *    "is this goal big enough to decompose?", "how should this failure
 *    be recovered from?") - it never freely improvises the control
 *    flow. This is the architecture professional coding/ops agents
 *    actually use in production (unlike raw hybrid symbolic-neural
 *    robotics stacks, which is where this pattern is more commonly
 *    associated) precisely because a person on a phone with no PC
 *    needs a plan that survives an app restart, shows real progress,
 *    and asks before doing something risky - none of which a purely
 *    neural ReAct loop guarantees on its own.
 *
 * ============================================================
 * WHERE CLAUDE ITSELF SITS (the model ZAO's planning loop is modeled
 * after - see planTypes.js's header comment)
 * ============================================================
 * Claude, per model size (Haiku/Sonnet/Opus), is a single DENSE
 * TRANSFORMER - no MoE, no multi-brain routing *inside* one Claude
 * response. What looks like "Claude has a planning brain and an
 * execution brain" from the outside is one dense network conditioned
 * differently by the system prompt/tools/context at each turn - the
 * multi-role, hybrid-symbolic structure lives in the PRODUCT surface
 * around Claude (e.g. Claude Code's plan mode, tool loops, memory),
 * not inside the model's weights. ZAO's architecture mirrors that
 * split deliberately: ONE dense-transformer model (type 1) underneath,
 * with the multi-brain/ensemble roles (type 3) and the symbolic
 * scaffold (type 4) built entirely in this app's own code, not in the
 * model.
 *
 * ============================================================
 * ZAO'S ACTUAL BRAIN ARCHITECTURE, END TO END
 * ============================================================
 *   Model layer      -> unknown/undisclosed (Ox Alpha; an anonymous
 *                        stealth-preview model on OpenRouter - see
 *                        localModels.js's header comment and
 *                        ZAO_BRAIN_PROFILE below)
 *   Prompting layer   -> MULTI_BRAIN_ENSEMBLE (BRAIN_ROLES below - one
 *                        model, many system-prompt "hats")
 *   Control-flow layer -> HYBRID_SYMBOLIC_NEURAL (src/services/planning/
 *                        - deterministic graph + gating code, narrow
 *                        neural judgment calls inside it)
 *   Split across TWO physical brains, not one:
 *     FRONTEND BRAIN  -> runs on the phone. Cheap, local, no model
 *                        call: routing heuristics, UI state, "does this
 *                        even need a model?" gating. See
 *                        frontendBrain.js.
 *     BACKEND BRAIN   -> the model call itself happens on OpenRouter,
 *                        relayed by the Alibaba Cloud VM (server/,
 *                        backendClient.js) rather than hosted on it -
 *                        classification, planning, execution judgment,
 *                        recovery judgment, plain chat all go out over
 *                        that relay. See backendBrain.js.
 */

export const BRAIN_ARCHITECTURES = Object.freeze({
  DENSE_TRANSFORMER: 'dense_transformer',
  MIXTURE_OF_EXPERTS: 'mixture_of_experts',
  MULTI_BRAIN_ENSEMBLE: 'multi_brain_ensemble',
  HYBRID_SYMBOLIC_NEURAL: 'hybrid_symbolic_neural',
});

/** Human-readable description of each architecture - used nowhere functionally, kept for any future "About ZAO's architecture" settings panel or debug screen. */
export const BRAIN_ARCHITECTURE_LABELS = Object.freeze({
  [BRAIN_ARCHITECTURES.DENSE_TRANSFORMER]: 'Dense transformer - one network, every parameter active every token.',
  [BRAIN_ARCHITECTURES.MIXTURE_OF_EXPERTS]: 'Mixture-of-Experts - many sub-networks, only some active per token.',
  [BRAIN_ARCHITECTURES.MULTI_BRAIN_ENSEMBLE]: 'Multi-brain / ensemble - separate roles (or models) for separate jobs.',
  [BRAIN_ARCHITECTURES.HYBRID_SYMBOLIC_NEURAL]: 'Hybrid symbolic-neural - a rules/logic engine wrapped around neural judgment calls.',
});

/**
 * ZAO's own classification against the taxonomy above. Ox Alpha is an
 * anonymous stealth-preview model on OpenRouter - its actual architecture
 * (dense vs Mixture-of-Experts) isn't published, unlike the old
 * Qwen3-Coder-30B-A3B-Instruct setup where it was a known, documented
 * spec. DENSE_TRANSFORMER and MIXTURE_OF_EXPERTS below are both marked
 * `implemented: false` for that reason - not because either is wrong,
 * but because neither is confirmed. Update this once/if OpenRouter or the
 * model itself discloses which it is. ZAO's own code never does any
 * expert routing either way; that would be entirely internal to the model
 * and opaque to this app regardless.
 */
export const ZAO_BRAIN_PROFILE = Object.freeze({
  [BRAIN_ARCHITECTURES.DENSE_TRANSFORMER]: {
    implemented: false,
    where: null,
    reason: 'Unknown - Ox Alpha (src/config/localModels.js) is an anonymous stealth-preview model on OpenRouter; its architecture isn\'t published. Not ruled out.',
  },
  [BRAIN_ARCHITECTURES.MIXTURE_OF_EXPERTS]: {
    implemented: false,
    where: null,
    reason: 'Unknown, same as DENSE_TRANSFORMER above - Ox Alpha\'s architecture isn\'t disclosed. If it does turn out to be MoE, the routing would happen entirely inside the model\'s own weights either way - ZAO\'s code never touches it directly.',
  },
  [BRAIN_ARCHITECTURES.MULTI_BRAIN_ENSEMBLE]: {
    implemented: true,
    where: 'src/services/brain/backendBrain.js\'s BRAIN_ROLES, plus every role-specific prompt already in src/services/planning/ (strategicPlanner, projectPlanner, taskPlanner, executionPlanner, resourcePlanner, milestonePlanner, recoveryPlanner) and src/services/intentClassifier.js - all separate roles, ONE underlying model.',
  },
  [BRAIN_ARCHITECTURES.HYBRID_SYMBOLIC_NEURAL]: {
    implemented: true,
    where: 'src/services/planning/ (the symbolic half: planTypes.js, planCoordinator.js, planExecutor.js, riskClassifier.js, checkpointBalancer.js, the plans/plan_steps schema in src/db/database.js) wrapping narrow neural judgment calls made through backendBrain.js.',
  },
});
