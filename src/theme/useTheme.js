/**
 * ZAO - useTheme Hook
 *
 * Single source every screen/component calls to get the actual resolved
 * theme object. Combines the stored preference (auto/light/dark) with the
 * phone's live system color scheme when preference is 'auto'.
 *
 * Usage:
 *   const theme = useTheme();
 *   <View style={{ backgroundColor: theme.background }}>
 */

import { useColorScheme } from 'react-native';
import { useThemeStore } from '../store/themeStore';
import { getTheme } from './tokens';

export function useTheme() {
  const systemScheme = useColorScheme(); // 'light' | 'dark' | null, updates live
  const themePreference = useThemeStore((state) => state.themePreference);

  const resolvedMode = themePreference === 'auto'
    ? (systemScheme || 'light') // fall back to light if system reports null (some emulators/old devices)
    : themePreference;

  return getTheme(resolvedMode);
}

/**
 * Non-hook version for places that need the resolved mode string itself
 * (e.g. StatusBar barStyle) without pulling the whole theme object.
 */
export function useResolvedThemeMode() {
  const systemScheme = useColorScheme();
  const themePreference = useThemeStore((state) => state.themePreference);
  return themePreference === 'auto' ? (systemScheme || 'light') : themePreference;
}
