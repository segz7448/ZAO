/**
 * ZAO - Theme Tokens
 *
 * Two full palettes (light/dark). Every screen/component should pull colors
 * from useTheme() rather than hardcoding hex values, so theme switching
 * actually reaches everywhere at once.
 */

export const lightTheme = {
  mode: 'light',
  background: '#FEFCF8',
  surface: '#FFFFFF',
  surfaceAlt: '#F3F4F6',
  border: '#F3F4F6',
  borderStrong: '#E5E7EB',

  textPrimary: '#1F2937',
  textSecondary: '#6B7280',
  textTertiary: '#9CA3AF',
  textInverse: '#FFFFFF',

  accent: '#1F2937',
  accentSoft: '#F3F4F6',
  brand: '#EA580C', // the orange sunburst accent from the reference screenshots

  bubbleUser: '#1F2937',
  bubbleAssistant: '#F3F4F6',
  bubbleUserText: '#FFFFFF',
  bubbleAssistantText: '#1F2937',

  success: '#22C55E',
  warning: '#EAB308',
  danger: '#EF4444',
  dangerSoft: '#FEF2F2',
  dangerBorder: '#FECACA',
  dangerText: '#B91C1C',

  info: '#3B82F6',
  infoSoft: '#EFF6FF',

  overlay: 'rgba(0,0,0,0.4)',
  statusBarStyle: 'dark-content',
};

export const darkTheme = {
  mode: 'dark',
  background: '#131313',
  surface: '#1E1E1E',
  surfaceAlt: '#262626',
  border: '#2A2A2A',
  borderStrong: '#363636',

  textPrimary: '#F3F4F6',
  textSecondary: '#A3A3A3',
  textTertiary: '#737373',
  textInverse: '#131313',

  accent: '#F3F4F6',
  accentSoft: '#262626',
  brand: '#F97316',

  bubbleUser: '#F3F4F6',
  bubbleAssistant: '#262626',
  bubbleUserText: '#131313',
  bubbleAssistantText: '#F3F4F6',

  success: '#4ADE80',
  warning: '#FACC15',
  danger: '#F87171',
  dangerSoft: '#2A1616',
  dangerBorder: '#4A2323',
  dangerText: '#F87171',

  info: '#60A5FA',
  infoSoft: '#1A2332',

  overlay: 'rgba(0,0,0,0.6)',
  statusBarStyle: 'light-content',
};

export function getTheme(mode) {
  return mode === 'dark' ? darkTheme : lightTheme;
}
