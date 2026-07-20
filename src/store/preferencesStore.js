/**
 * ZAO - Preferences Store (Zustand)
 *
 * Voice mode, TTS, Gemini, and Hugging Face are gone - chat/coding/
 * reasoning all run through the single Termux-hosted backend (see
 * src/services/backend/backendClient.js), so there's nothing to configure
 * per-provider anymore beyond GitHub (still needs the person's own token).
 */

import { create } from 'zustand';
import { getPreferences, updatePreferences, storeApiKey, getApiKey, deleteApiKey } from '../db/database';

import { PERMISSION_MODES } from '../services/execution/permissionModes';

const DEFAULT_PREFS = {
  browser_access_enabled: false,
  memory_enabled: true,
  backend_mode: 'lan',
  backend_lan_url: null,
  backend_remote_url: null,
  backend_auth_token: null,
  permission_mode: 'default',
  otel_export_endpoint: null,
};

export const usePreferencesStore = create((set, get) => ({
  preferences: DEFAULT_PREFS,
  isLoaded: false,
  apiKeyStatus: {
    github: { configured: false, isUserProvided: false, isTrial: false, username: null },
  },

  async loadPreferences() {
    const result = await getPreferences();
    set({
      preferences: result.data || DEFAULT_PREFS,
      isLoaded: true,
    });

    const githubToken = await getApiKey('github');
    set({
      apiKeyStatus: {
        github: {
          // No trial concept here - GitHub write access has to be the
          // person's own account, there's no "default" token that would
          // make sense to bake into the app.
          configured: !!githubToken?.data?.key_value,
          isUserProvided: !!githubToken?.data?.is_user_provided,
          isTrial: false,
          username: result.data?.github_username || null,
        },
      },
    });
  },

  /**
   * Toggles the composer bar's globe/browser-access icon. This is the
   * explicit on/off gate for the on-device browser agent:
   * sendMessageOrchestrated() only auto-browses when this is true.
   * Persisted to SQLite (not just local component state) so the toggle
   * "remembers" what the person last set it to across app restarts - it
   * does NOT auto-revert to off on its own; only an explicit tap turns it
   * off.
   */
  async setBrowserAccessEnabled(enabled) {
    const prev = get().preferences;
    set({ preferences: { ...prev, browser_access_enabled: enabled } }); // optimistic
    const result = await updatePreferences({ browser_access_enabled: enabled });
    if (!result.success) {
      set({ preferences: prev }); // revert on failure
    }
  },

  /**
   * Toggles the long-term Memory feature (Settings > Memory - see
   * src/services/memory/memoryEngine.js). Turning this off stops both
   * context injection into new messages AND new-fact extraction, but does
   * NOT delete memories already stored - those stay until the person
   * explicitly clears them via the Memory settings screen.
   */
  async setMemoryEnabled(enabled) {
    const prev = get().preferences;
    set({ preferences: { ...prev, memory_enabled: enabled } }); // optimistic
    const result = await updatePreferences({ memory_enabled: enabled });
    if (!result.success) {
      set({ preferences: prev }); // revert on failure
    }
  },

  /**
   * Toggles which backend connection the app uses: 'lan' (PC's local IP,
   * used at home) or 'remote' (the Cloudflare Quick Tunnel URL, used away
   * from home). Manual toggle by design - see backendClient.js for why
   * this isn't auto-detected.
   */
  async setBackendMode(mode) {
    const prev = get().preferences;
    set({ preferences: { ...prev, backend_mode: mode } }); // optimistic
    const result = await updatePreferences({ backend_mode: mode });
    if (!result.success) {
      set({ preferences: prev }); // revert on failure
    }
    return result;
  },

  /** PC's local IP:port, e.g. http://192.168.1.42:8080 - used in LAN mode. */
  async setBackendLanUrl(url) {
    const prev = get().preferences;
    set({ preferences: { ...prev, backend_lan_url: url } }); // optimistic
    const result = await updatePreferences({ backend_lan_url: url });
    if (!result.success) {
      set({ preferences: prev }); // revert on failure
    }
    return result;
  },

  /**
   * The Cloudflare Quick Tunnel URL - used in Remote mode. Rotates every
   * time start.bat is re-run on the PC (free *.trycloudflare.com URL, not
   * a permanent named tunnel), so this needs to be re-entered whenever the
   * PC's tunnel restarts.
   */
  async setBackendRemoteUrl(url) {
    const prev = get().preferences;
    set({ preferences: { ...prev, backend_remote_url: url } }); // optimistic
    const result = await updatePreferences({ backend_remote_url: url });
    if (!result.success) {
      set({ preferences: prev }); // revert on failure
    }
    return result;
  },

  /**
   * Shared-secret token sent as `Authorization: Bearer <token>` on every
   * backend request - must match AUTH_TOKEN in the PC's server/config.js.
   * Stored as a plain preference rather than the secure api_keys table:
   * it's a self-issued value the person picks (not a third-party secret
   * like a GitHub PAT), and it needs to be trivially copy/paste-visible in
   * Settings for the person to match it against their PC's config.js.
   */
  async setBackendAuthToken(token) {
    const prev = get().preferences;
    set({ preferences: { ...prev, backend_auth_token: token } }); // optimistic
    const result = await updatePreferences({ backend_auth_token: token });
    if (!result.success) {
      set({ preferences: prev }); // revert on failure
    }
    return result;
  },

  /**
   * Switches which of the five permission modes (src/services/execution/
   * permissionModes.js) every tool call in toolOrchestrator.js /
   * planExecutor.js gets gated against - 'default' | 'acceptEdits' |
   * 'plan' | 'auto' | 'bypassPermissions'. Interactively switchable
   * mid-conversation (Settings > Permissions, or a quick-switch chip in
   * the chat composer) - the NEXT tool call after switching immediately
   * uses the new mode, since runToolTask() reads permission_mode fresh
   * from preferences at the start of every call rather than caching it.
   */
  async setPermissionMode(mode) {
    if (!PERMISSION_MODES.includes(mode)) {
      return { success: false, error: `Unknown permission mode: ${mode}` };
    }
    const prev = get().preferences;
    set({ preferences: { ...prev, permission_mode: mode } }); // optimistic
    const result = await updatePreferences({ permission_mode: mode });
    if (!result.success) {
      set({ preferences: prev }); // revert on failure
    }
    return result;
  },

  /**
   * Optional OTLP/HTTP collector endpoint telemetry.js best-effort
   * forwards spans to, on top of always writing them locally to
   * agent_actions. Null (the default) means local-only.
   */
  async setOtelExportEndpoint(url) {
    const prev = get().preferences;
    set({ preferences: { ...prev, otel_export_endpoint: url } }); // optimistic
    const result = await updatePreferences({ otel_export_endpoint: url });
    if (!result.success) {
      set({ preferences: prev }); // revert on failure
    }
    return result;
  },

  async setApiKey(provider, keyValue) {
    const result = await storeApiKey(provider, keyValue, true);
    if (result.success) {
      set((state) => ({
        apiKeyStatus: {
          ...state.apiKeyStatus,
          [provider]: { ...state.apiKeyStatus[provider], configured: !!keyValue, isUserProvided: true, isTrial: false },
        },
      }));
    }
    return result;
  },

  // GitHub is the one provider where the app needs a piece of non-secret
  // metadata (the username) alongside the token - stored as a normal
  // preference rather than the secure api_keys table, since it isn't
  // sensitive and every GitHub API call needs it for owner/repo paths.
  /**
   * Grants device folder access via Android's SAF picker and refreshes the
   * store's own `preferences` afterward. requestAccess() (filesystemTool.js)
   * writes filesystem_saf_uri straight to SQLite via updatePreferences() -
   * it does NOT go through this store, so without the loadPreferences()
   * call below the in-memory `preferences` object here stays stale and any
   * screen reading `preferences.filesystem_saf_uri` (e.g. Settings'
   * "Granted"/"Not granted" pill) keeps showing the old value until the
   * app is restarted, even though the grant itself succeeded and persisted.
   */
  async grantFilesystemAccess() {
    const { requestAccess } = await import('../services/filesystem/filesystemTool');
    const result = await requestAccess();
    if (result.success) {
      await get().loadPreferences();
    }
    return result;
  },

  async setGithubUsername(username) {
    const prev = get().preferences;
    set({ preferences: { ...prev, github_username: username } }); // optimistic
    const result = await updatePreferences({ github_username: username });
    if (result.success) {
      set((state) => ({
        apiKeyStatus: { ...state.apiKeyStatus, github: { ...state.apiKeyStatus.github, username } },
      }));
    }
    return result;
  },

  async removeApiKey(provider) {
    const result = await deleteApiKey(provider);
    if (result.success) {
      if (provider === 'github') {
        // Clear the stored username too - a token-less username sitting
        // around would be confusing ("configured: false" but a username
        // still showing) and serves no purpose without the token it
        // pairs with.
        await updatePreferences({ github_username: null });
      }
      await get().loadPreferences();
    }
    return result;
  },
}));
