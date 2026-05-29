/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        bg: '#0d0d0e',
        surface: '#1a1a1c',
        border: '#2a2a2e',
        text: '#e4e4e7',
        muted: '#71717a',
        accent: '#6366f1',
        danger: '#ef4444',
      },
    },
  },
  plugins: [],
};
