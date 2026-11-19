import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Tests cover lib/, the app's logic that doesn't import React Native.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, '../src/shared'),
      '@': __dirname,
    },
  },
  test: {
    include: ['lib/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    poolOptions: { forks: { maxForks: 2, minForks: 1 } },
  },
});
