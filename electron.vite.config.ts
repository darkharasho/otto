import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: { outDir: 'out/main', rollupOptions: { input: 'src/main/index.ts' } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: { outDir: 'out/preload', rollupOptions: { input: 'src/preload/index.ts' } },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer'),
      },
    },
    build: { outDir: 'out/renderer', rollupOptions: { input: 'src/renderer/index.html' } },
  },
});
