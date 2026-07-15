/**
 * ZAO - Theme Store
 *
 * Three-way preference: 'auto' | 'light' | 'dark'.
 * - 'auto' follows the phone's system light/dark setting live (updates if
 *   the person changes their phone's setting while the app is open).
 * - 'light' / 'dark' are sticky - they stay exactly as chosen regardless of
 *   system setting, until the person changes it again in Settings.
 *
 * This store only holds the PREFERENCE. The actual resolved theme object
 * (light or dark tokens) is computed in useTheme() by combining this
 * preference with the live system color scheme - see src/theme/useTheme.js.
 */

import { create } from 'zustand';
import { getPreferences, updatePreferences } from '../db/database';

export const useThemeStore = create((set, get) => ({
  themePreference: 'auto', // 'auto' | 'light' | 'dark'
  isLoaded: false,

  async loadThemePreference() {
    const result = await getPreferences();
    set({
      themePreference: result.data?.theme_preference || 'auto',
      isLoaded: true,
    });
  },

  async setThemePreference(preference) {
    const prev = get().themePreference;
    set({ themePreference: preference }); // optimistic
    const result = await updatePreferences({ theme_preference: preference });
    if (!result.success) {
      set({ themePreference: prev }); // revert on failure
    }
  },
}));
