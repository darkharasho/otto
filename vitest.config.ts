import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@renderer': resolve('src/renderer'),
      '@renderer-shared': resolve('src/renderer-shared'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['src/renderer/test-setup.ts'],
    // otto-mobile/lib holds the iOS app's pure logic (no React Native imports).
    include: ['src/**/*.test.{ts,tsx}', 'otto-mobile/lib/**/*.test.ts'],
    // Cap parallelism so a full run doesn't saturate the machine. Without this,
    // Vitest spawns one worker per core. Forks pool + maxForks:2 keeps it to two.
    pool: 'forks',
    poolOptions: {
      forks: { maxForks: 2, minForks: 1 },
    },
    maxWorkers: 2,
    minWorkers: 1,
  },
});
