/**
 * ZAO - Preferences Store (Zustand)
 *
 * Voice mode, TTS, Gemini, and Hugging Face are gone - chat/coding/
 * reasoning all run through the single PC-hosted backend (see
 * src/services/backend/backendClient.js), so there's nothing to configure
 * per-provider anymore beyond GitHub (still needs the person's own token).
 */

import { create } from 'zustand';
import { getPreferences, updatePreferences, storeApiKey, getApiKey, deleteApiKey } from '../db/database';

import { PERMISSION_MODES } from '../services/execution/permissionModes';

const DEFAULT_PREFS = {
  theme_preference: 'auto',
  browser_access_enabled: false,
  web_search_enabled: false,
  github_tools_enabled: false,
  github_username: null,
  filesystem_saf_uri: null,
  memory_enabled: true,
  project_instructions: null,
  auto_memory_notes: null,
  backend_vm_url: null,
  backend_auth_token: null,
  openrouter_api_key: null,
  permission_mode: 'auto',
  otel_export_endpoint: null,
  preferred_timezone: null,
  browser_router_url: null, // dead field - see database.js's DEFAULT_PREFS_ROW comment
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
   * "Add to chat" sheet's Web search toggle (src/components/
   * AttachmentSheet.js). Persisted to SQLite, same as
   * setBrowserAccessEnabled above - survives app restarts, only changes
   * on an explicit tap, never auto-reverts on its own (see the
   * web_search_enabled migration comment in database.js for why this
   * used to silently reset and doesn't anymore).
   */
  async setWebSearchEnabled(enabled) {
    const prev = get().preferences;
    set({ preferences: { ...prev, web_search_enabled: enabled } }); // optimistic
    const result = await updatePreferences({ web_search_enabled: enabled });
    if (!result.success) {
      set({ preferences: prev }); // revert on failure
    }
  },

  /**
   * "Add to chat" sheet's GitHub toggle. When on, frontendBrain.js's
   * decideRoute() treats a GitHub/repo-flavored message as a confident
   * 'github' route rather than leaving it to the classifier's guess -
   * see GITHUB_INTENT_PATTERN in frontendBrain.js. Requires the
   * person's own GitHub username + token to already be set up
   * (Settings > GitHub) - this toggle controls ROUTING confidence, not
   * whether the credentials exist; an unconfigured account still gets a
   * clear "add your GitHub token in Settings" answer rather than a
   * silent failure. Persisted the same way as every other toggle here -
   * survives app restarts, only an explicit tap changes it.
   */
  async setGithubToolsEnabled(enabled) {
    const prev = get().preferences;
    set({ preferences: { ...prev, github_tools_enabled: enabled } }); // optimistic
    const result = await updatePreferences({ github_tools_enabled: enabled });
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
   * The Alibaba Cloud VM's fixed IP (or IP:port), e.g.
   * http://123.45.67.89:8000 - the one server ZAO now talks to for
   * everything (model inference, terminal, filesystem, git, etc.). No
   * LAN/Remote toggle anymore - the VM is 24/7 and always reachable at
   * this same address.
   */
  async setBackendVmUrl(url) {
    const prev = get().preferences;
    set({ preferences: { ...prev, backend_vm_url: url } }); // optimistic
    const result = await updatePreferences({ backend_vm_url: url });
    if (!result.success) {
      set({ preferences: prev }); // revert on failure
    }
    return result;
  },

  /**
   * The VM's own shared secret (labeled "Model API key" in Settings for
   * historical reasons - it gates the VM itself, not the model provider;
   * see setOpenrouterApiKey() below for that one), sent as
   * `Authorization: Bearer <token>` on every request to the VM - must
   * match AUTH_TOKEN in the VM's server/config.js. Stored as a plain
   * preference rather than the secure api_keys table: it's a self-issued
   * value the person picks (not a third-party secret like a GitHub PAT),
   * and it needs to be trivially copy/paste-visible in Settings for the
   * person to match it against their VM's config.js.
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
   * The person's own OpenRouter API key (from https://openrouter.ai/keys),
   * sent on every VM request as `X-OpenRouter-Key` (see
   * backendClient.js's authHeaders()) - this is what the VM actually uses
   * to call OpenRouter for chat completions now that the model has moved
   * off Alibaba Model Studio. Separate from backend_auth_token above,
   * which still just gates access to the VM itself. Same "plain
   * preference, not the secure api_keys table" tradeoff as
   * backend_auth_token - see that setter's comment; a future pass could
   * move both to expo-secure-store alongside the GitHub token.
   */
  async setOpenrouterApiKey(key) {
    const prev = get().preferences;
    set({ preferences: { ...prev, openrouter_api_key: key } }); // optimistic
    const result = await updatePreferences({ openrouter_api_key: key });
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
