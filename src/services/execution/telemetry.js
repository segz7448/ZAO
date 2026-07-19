/**
 * ZAO - Telemetry / Observability
 *
 * This is the "queryable record of what the agent did and why" that
 * SYSTEM_COMPONENTS.md flagged as the one fully-missing piece of ZAO's
 * architecture ("no table recording, per tool call, what was called,
 * with what arguments, what it returned... 'why did ZAO do X three days
 * ago' has no answer"). It closes that gap AND gives ZAO an
 * OpenTelemetry-shaped event model (trace_id / span_id / parent_span_id /
 * attributes / status / start-end timing) - not a full OTel SDK (this is
 * a React Native app with no persistent background process to run a real
 * OTel exporter loop), but the same shape, persisted locally
 * (agent_actions table, src/db/database.js), with an OPTIONAL best-effort
 * HTTP forward to a real OTLP/HTTP collector if the person configures one
 * (user_preferences.otel_export_endpoint) - local-first, cloud-optional.
 *
 * One trace per top-level request (one runToolTask() call, one
 * runExecutionPlan() call). One span per tool call within it. A
 * subagent's spawn call is itself a span, and everything the subagent
 * does gets parent_span_id set to that span - so a trace naturally nests,
 * the same way an OTel trace does for any parent/child call structure.
 */

import { startAgentAction, endAgentAction, getAgentActionsForSession, getRecentAgentActions, getPreferences } from '../../db/database';

function randomId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Starts a new trace (one per top-level request) - returns the traceId every span in this request should share. */
export function newTraceId() {
  return randomId('trace');
}

/**
 * Starts a span and persists it immediately (status: 'running') so a
 * crash mid-call still leaves a record instead of silently vanishing.
 * @returns {Promise<{spanId: string, traceId: string}>}
 */
export async function startSpan({ traceId, parentSpanId = null, sessionId = null, conversationId = null, name, toolName = null, attributes = null }) {
  const spanId = randomId('span');
  await startAgentAction({ id: spanId, traceId, spanId, parentSpanId, sessionId, conversationId, name, toolName, attributes });
  return { spanId, traceId };
}

export async function endSpan(spanId, { status = 'ok', errorMessage = null, attributes = null } = {}) {
  await endAgentAction(spanId, { status, errorMessage, attributes });
  maybeExport(spanId, status).catch(() => {});
}

/**
 * Convenience wrapper for the common case (a tool call that starts and
 * ends synchronously from the caller's perspective) - avoids every call
 * site in toolOrchestrator.js needing to manage start/end bookkeeping by
 * hand.
 */
export async function recordSpan({ traceId, parentSpanId = null, sessionId = null, conversationId = null, name, toolName = null, attributes = null }, fn) {
  const { spanId } = await startSpan({ traceId, parentSpanId, sessionId, conversationId, name, toolName, attributes });
  try {
    const result = await fn();
    await endSpan(spanId, { status: result?.success === false ? 'error' : 'ok', errorMessage: result?.error?.message || null });
    return result;
  } catch (err) {
    await endSpan(spanId, { status: 'error', errorMessage: err?.message || String(err) });
    throw err;
  }
}

export async function getTrace(sessionId) {
  const result = await getAgentActionsForSession(sessionId);
  return result.data;
}

export async function getRecentSpans(limit = 100) {
  const result = await getRecentAgentActions(limit);
  return result.data;
}

// Best-effort OTLP/HTTP-ish forward - fire-and-forget, never blocks or
// throws into the caller. Off by default (otel_export_endpoint is null
// until the person sets one in Settings). This deliberately does NOT
// batch/queue - one fetch per ended span - since ZAO's tool-call volume
// is low enough (interactive, human-paced requests, not high-throughput
// service traffic) that a real batching exporter would be overengineering
// for what this app actually produces.
async function maybeExport(spanId, status) {
  const prefs = await getPreferences();
  const endpoint = prefs?.data?.otel_export_endpoint;
  if (!endpoint) return;
  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spanId, status, source: 'zao', exportedAt: Date.now() }),
    });
  } catch {
    // Offline-first: a failed export is silently dropped, not retried -
    // the span is already durably in agent_actions regardless.
  }
}
