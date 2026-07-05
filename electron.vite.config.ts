import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: 'src/main/index.ts',
        external: ['@huggingface/transformers'],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: { outDir: 'out/preload', rollupOptions: { input: 'src/preload/index.ts' } },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [
      react(),
      viteStaticCopy({
        targets: [
          {
            src: resolve('node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js'),
            dest: 'vad',
          },
          {
            src: resolve('node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx'),
            dest: 'vad',
          },
          {
            src: resolve('node_modules/@ricky0123/vad-web/dist/silero_vad_legacy.onnx'),
            dest: 'vad',
          },
          // onnxruntime-web 1.27.0 (resolved by vad-web 0.0.30) — wasm backends
          {
            src: resolve(
              'node_modules/.pnpm/@ricky0123+vad-web@0.0.30/node_modules/onnxruntime-web/dist/*.wasm',
            ),
            dest: 'vad',
          },
          {
            src: resolve(
              'node_modules/.pnpm/@ricky0123+vad-web@0.0.30/node_modules/onnxruntime-web/dist/*.mjs',
            ),
            dest: 'vad',
          },
        ],
      }),
    ],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer'),
        '@renderer-shared': resolve('src/renderer-shared'),
      },
    },
    build: { outDir: 'out/renderer', rollupOptions: { input: 'src/renderer/index.html' } },
  },
});
