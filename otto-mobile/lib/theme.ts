import { Platform } from 'react-native';

// The app is dark-only (app.json userInterfaceStyle: "dark"), matching Otto on
// the desktop. Use these instead of hex literals.
export const colors = {
  bg: '#0d0d0e',
  surface: '#1a1a1c',
  border: '#2a2a2e',
  text: '#e4e4e7',
  textMuted: '#71717a',
  textDim: '#8b8d92',
  accent: '#6366f1',
  accentBg: 'rgba(99,102,241,0.1)',
  accentBorder: 'rgba(99,102,241,0.3)',
  success: '#10b981',
  warning: '#f59e0b',
  danger: '#ef4444',
  dangerBg: 'rgba(239,68,68,0.12)',
  dangerBorder: 'rgba(239,68,68,0.4)',
  well: 'rgba(13,13,14,0.6)',
  white: '#ffffff',
} as const;

export const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });
