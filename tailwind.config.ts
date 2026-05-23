import type { Config } from 'tailwindcss';

export default {
  content: ['src/renderer/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        bg: '#0d0d0e',
        surface: '#17181a',
        border: '#2a2b2e',
        text: '#e9eaec',
        muted: '#8b8d92',
        accent: '#7c7dff',
        danger: '#ef4444',
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config;
