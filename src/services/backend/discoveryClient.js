/**
 * ZAO - Backend Auto-Discovery Client
 *
 * WHY THIS EXISTS: see cloudflare-worker/discovery-worker.js's header
 * for the full story. In short - the PC's tunnel URL still exists (it
 * has to; that's how networking works), but nobody wants to type or
 * copy it. This module is the phone-side half: given a discovery
 * Worker URL + deviceId (entered ONCE in Settings > Backend Connection
 * > Auto-discovery), it looks up the PC's current backend hostname and
 * writes it straight into backend_remote_url - the exact same
 * preference the manual "Remote URL" field in Settings has always
 * written to, so backendClient.js's getActiveConnection() needed ZERO
 * changes to support this; it just sees a URL that filled itself in.
 *
 * If the PC's tunnel is ever recreated (setup-permanent-tunnel.js
 * re-run), the next successful lookup here picks up the new hostname
 * automatically - no re-entry needed on the phone side, ever, as long
 * as the Worker URL + deviceId themselves don't change.
 *
 * This is entirely optional - a person can still ignore Auto-discovery
 * and type backend_remote_url in manually, same as before. Nothing here
 * runs unless discovery_worker_url and discovery_device_id are both set.
 */

import { usePreferencesStore } from '../../store/preferencesStore';

/**
 * Looks up the current backend hostname from the discovery Worker and
 * writes it into backend_remote_url if it changed. Safe to call
 * anywhere, anytime - a no-op if discovery isn't configured, and fails
 * silently (keeps whatever backend_remote_url already had) on any
 * network hiccup, since a stale-but-present URL is better than wiping
 * out a working one over a flaky request.
 *
 * @returns {Promise<{ updated: boolean, hostname: string|null, error: string|null }>}
 */
export async function refreshDiscoveredBackendUrl() {
  const prefs = usePreferencesStore.getState().preferences || {};
  const workerUrl = prefs.discovery_worker_url;
  const deviceId = prefs.discovery_device_id;

  if (!workerUrl || !deviceId) {
    return { updated: false, hostname: null, error: null };
  }

  try {
    const res = await fetch(`${workerUrl.replace(/\/+$/, '')}/lookup?deviceId=${encodeURIComponent(deviceId)}`);
    const json = await res.json();
    if (!res.ok || !json.success || !json.hostname) {
      return { updated: false, hostname: null, error: json.error || `Lookup failed (${res.status})` };
    }

    const newUrl = `https://${json.hostname}`;
    if (prefs.backend_remote_url === newUrl) {
      return { updated: false, hostname: json.hostname, error: null };
    }

    await usePreferencesStore.getState().setBackendRemoteUrl(newUrl);
    return { updated: true, hostname: json.hostname, error: null };
  } catch (err) {
    // Network hiccup, Worker unreachable, etc. - fail silently and keep
    // whatever backend_remote_url already had (see this function's own
    // doc above for why that's the right default).
    return { updated: false, hostname: null, error: err?.message || 'Network error' };
  }
}
