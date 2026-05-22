import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/integration',
  timeout: 30_000,
  fullyParallel: false,
  reporter: 'list',
  use: {
    trace: 'retain-on-failure',
  },
});
