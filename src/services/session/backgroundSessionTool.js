/**
 * ZAO - Background Session Tool
 *
 * Thin { success, data, error } wrapper (same shape every other
 * TOOL_REGISTRY entry uses) around the backend's resumable background
 * sessions (see server/backgroundSessions.js's file header for the full
 * picture): start a long task, it keeps running on the PC after the
 * phone app closes, and any later turn - this conversation or a fresh
 * one - can check its status, read its log, or read its final answer.
 *
 * This deliberately does NOT try to keep the phone "connected" to a
 * running session in any live-streaming sense - it's poll-based, on
 * purpose, since the whole point is that the phone doesn't need to stay
 * open or connected for the work to continue.
 */

import {
  startBackgroundSession,
  getBackgroundSession,
  listBackgroundSessions,
  stopBackgroundSession,
} from '../backend/backendClient';

/** @param {string} prompt - a complete, self-contained description of the task, same bar as agent_spawn_subagents' prompt field, since the background session has no other context to draw on either */
export async function start(prompt) {
  if (!prompt || !prompt.trim()) {
    return { success: false, data: null, error: { message: 'A task description is required.' } };
  }
  return startBackgroundSession(prompt.trim());
}

/** @param {string} id */
export async function check(id) {
  if (!id) return { success: false, data: null, error: { message: 'A session id is required.' } };
  return getBackgroundSession(id);
}

export async function list() {
  return listBackgroundSessions();
}

/** @param {string} id */
export async function stop(id) {
  if (!id) return { success: false, data: null, error: { message: 'A session id is required.' } };
  return stopBackgroundSession(id);
}
