/**
 * ZAO - Dependency Planner (Planning type 4/8)
 *
 * "Handles dependencies" and "creates execution order" - this module is
 * where a flat list of tasks/steps with loose dependsOn references
 * becomes a validated DAG (directed acyclic graph) and a concrete
 * linear run order that respects every constraint in it.
 *
 * WHY THIS IS ITS OWN MODULE rather than folded into taskPlanner.js or
 * executionPlanner.js: dependency resolution is a pure graph problem,
 * not a planning judgment call - it doesn't need the model at all, and
 * keeping it model-free means it's fast, deterministic, and testable
 * without a backend connection. taskPlanner.js and executionPlanner.js
 * both hand it a loose graph (nodes + depends-on edges); this module is
 * the only place that does topological sort, cycle detection, and
 * fan-in/fan-out resolution. This mirrors how Claude, when it plans
 * multi-step work, keeps "what must happen before what" as an explicit
 * structural concern separate from "what are the parts" - conflating
 * the two is how circular or contradictory plans slip through.
 *
 * WHAT THIS PRODUCES: an ordered array (topologically sorted) plus, for
 * each node, its resolved depends-on set - ready for executionPlanner.js
 * to assign step_order and depends_on_step_id/depends_on_step_ids to.
 */

/**
 * @typedef {object} DependencyNode
 * @property {string} id
 * @property {string[]} dependsOnIds - ids of other nodes in the same graph that must complete first
 */

/**
 * Topologically sorts a set of nodes by their dependsOnIds edges using
 * Kahn's algorithm, and detects cycles. A cycle means two planners
 * produced a contradictory ordering (e.g. task A depends on B which
 * depends on A) - rather than silently picking an arbitrary order (which
 * could execute something before its real prerequisite), this surfaces
 * the cycle so the caller can break it deterministically.
 *
 * @param {DependencyNode[]} nodes
 * @returns {{ success: boolean, orderedIds: string[], cycleIds: string[]|null, error: string|null }}
 */
export function resolveExecutionOrder(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return { success: true, orderedIds: [], cycleIds: null, error: null };
  }

  const validIds = new Set(nodes.map((n) => n.id));
  const inDegree = new Map(nodes.map((n) => [n.id, 0]));
  const adjacency = new Map(nodes.map((n) => [n.id, []])); // id -> [ids that depend on it]

  for (const node of nodes) {
    const deps = (node.dependsOnIds || []).filter((depId) => validIds.has(depId) && depId !== node.id);
    inDegree.set(node.id, deps.length);
    for (const depId of deps) {
      adjacency.get(depId).push(node.id);
    }
  }

  // Kahn's algorithm: repeatedly peel off nodes with no remaining
  // unresolved dependencies, in the caller's original array order among
  // ties, so a plan with no real ordering constraints still comes out in
  // the order the planner listed things (predictable, not arbitrary).
  const queue = nodes.filter((n) => inDegree.get(n.id) === 0).map((n) => n.id);
  const orderedIds = [];
  const remainingInDegree = new Map(inDegree);

  while (queue.length > 0) {
    const currentId = queue.shift();
    orderedIds.push(currentId);
    for (const dependentId of adjacency.get(currentId) || []) {
      const newDegree = remainingInDegree.get(dependentId) - 1;
      remainingInDegree.set(dependentId, newDegree);
      if (newDegree === 0) queue.push(dependentId);
    }
  }

  if (orderedIds.length !== nodes.length) {
    const cycleIds = nodes.map((n) => n.id).filter((id) => !orderedIds.includes(id));
    return {
      success: false,
      orderedIds: [],
      cycleIds,
      error: `Circular dependency detected among ${cycleIds.length} item(s) - cannot resolve a valid execution order.`,
    };
  }

  return { success: true, orderedIds, cycleIds: null, error: null };
}

/**
 * Breaks a dependency cycle by dropping the weakest edge in it (the last
 * edge added, i.e. the dependency furthest from the node's own declared
 * order) - a pragmatic fallback used by planCoordinator.js only if a
 * planner ever produces a genuine cycle, so one bad edge doesn't block
 * the whole plan from being created. Always logs what it dropped so the
 * person/PlanScreen.js can see a note about it rather than a silent
 * reordering.
 *
 * @param {DependencyNode[]} nodes
 * @param {string[]} cycleIds - the subset of node ids identified as being in a cycle
 * @returns {{ nodes: DependencyNode[], droppedEdges: Array<{from: string, to: string}> }}
 */
export function breakCycle(nodes, cycleIds) {
  const cycleSet = new Set(cycleIds);
  const droppedEdges = [];
  const patched = nodes.map((node) => {
    if (!cycleSet.has(node.id) || !node.dependsOnIds?.length) return node;
    const keptDeps = [];
    let dropped = false;
    for (const depId of node.dependsOnIds) {
      if (!dropped && cycleSet.has(depId)) {
        droppedEdges.push({ from: depId, to: node.id });
        dropped = true; // only drop one edge per node - the minimum needed to break its participation in the cycle
        continue;
      }
      keptDeps.push(depId);
    }
    return { ...node, dependsOnIds: keptDeps };
  });
  return { nodes: patched, droppedEdges };
}

/**
 * Given a graph and a resolved linear order, computes for each node its
 * DIRECT dependency (single id, for plan_steps.depends_on_step_id - the
 * FK column) and its FULL dependency set (for
 * plan_steps.depends_on_step_ids - the fan-in CSV column). "Direct"
 * picks the dependency that appears latest in orderedIds among a node's
 * dependsOnIds, i.e. the one immediately before it on the critical path,
 * which is the most useful single predecessor to show in a simple UI.
 *
 * @param {DependencyNode[]} nodes
 * @param {string[]} orderedIds
 * @returns {Map<string, {directDependsOnId: string|null, allDependsOnIds: string[]}>}
 */
export function computeDependencyAssignments(nodes, orderedIds) {
  const positionById = new Map(orderedIds.map((id, index) => [id, index]));
  const result = new Map();

  for (const node of nodes) {
    const deps = (node.dependsOnIds || []).filter((id) => positionById.has(id));
    let directDependsOnId = null;
    if (deps.length > 0) {
      directDependsOnId = deps.reduce((latest, depId) =>
        positionById.get(depId) > positionById.get(latest) ? depId : latest
      , deps[0]);
    }
    result.set(node.id, { directDependsOnId, allDependsOnIds: deps });
  }

  return result;
}

/**
 * End-to-end helper: resolve order, auto-break a cycle if one exists
 * (logging what was dropped), and return both the order and the
 * per-node dependency assignment in one call - what planCoordinator.js
 * actually calls rather than wiring the three functions above together
 * itself every time.
 *
 * @param {DependencyNode[]} nodes
 * @returns {{ success: boolean, orderedIds: string[], assignments: Map, droppedEdges: Array, error: string|null }}
 */
export function planDependencies(nodes) {
  let workingNodes = nodes;
  let result = resolveExecutionOrder(workingNodes);
  let droppedEdges = [];

  if (!result.success && result.cycleIds?.length) {
    const broken = breakCycle(workingNodes, result.cycleIds);
    workingNodes = broken.nodes;
    droppedEdges = broken.droppedEdges;
    result = resolveExecutionOrder(workingNodes);
  }

  if (!result.success) {
    // Should be unreachable after one cycle-break pass on a
    // well-formed graph, but never leave the caller with a thrown
    // exception over a planning-graph edge case.
    return { success: false, orderedIds: [], assignments: new Map(), droppedEdges, error: result.error };
  }

  const assignments = computeDependencyAssignments(workingNodes, result.orderedIds);
  return { success: true, orderedIds: result.orderedIds, assignments, droppedEdges, error: null };
}
