import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Standalone Vite config for the iPhone-remote PWA bundle. Built separately
// from the Electron renderer because electron-vite expects a single renderer
// root. Output goes to out/renderer-remote and is served by BridgeServer.
// Reuses repo-root postcss.config.js + tailwind.config.ts.
export default defineConfig({
  root: resolve(__dirname, 'src/renderer-remote'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer-shared': resolve(__dirname, 'src/renderer-shared'),
    },
  },
  build: {
    outDir: resolve(__dirname, 'out/renderer-remote'),
    emptyOutDir: true,
  },
});
