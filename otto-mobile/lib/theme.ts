import { useColorScheme } from 'react-native';

const dark = {
  bg: '#0d0d0e',
  surface: '#1a1a1c',
  border: '#2a2a2e',
  text: '#e4e4e7',
  textMuted: '#71717a',
  accent: '#6366f1',
  accentBg: 'rgba(99,102,241,0.1)',
};

const light = {
  bg: '#f5f5f5',
  surface: '#ffffff',
  border: '#e0e0e3',
  text: '#1a1a1c',
  textMuted: '#71717a',
  accent: '#6366f1',
  accentBg: 'rgba(99,102,241,0.08)',
};

export type Theme = typeof dark;

export function useTheme(): Theme {
  const scheme = useColorScheme();
  return scheme === 'light' ? light : dark;
}
