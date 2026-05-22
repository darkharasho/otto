import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

test('skeleton smoke: send prompt, see streaming text + tool card', async () => {
  const cfg = mkdtempSync(path.join(tmpdir(), 'otto-e2e-'));
  const app = await electron.launch({
    args: [process.cwd()],
    env: {
      ...process.env,
      OTTO_FAKE_SDK: '1',
      XDG_CONFIG_HOME: cfg,
      NODE_ENV: 'test',
    },
  });

  const page = await app.firstWindow();
  await page.waitForSelector('input[placeholder*="Ask Otto" i]');

  // Window may start hidden; force show via Electron API for the test
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.show();
  });

  await page.fill('input[placeholder*="Ask Otto" i]', 'hi');
  await page.press('input[placeholder*="Ask Otto" i]', 'Enter');

  await expect(page.getByTestId('message-user')).toContainText('hi');
  await expect(page.getByTestId('message-assistant')).toContainText('echo: hi', { timeout: 5000 });
  await expect(page.getByText('echo', { exact: true })).toBeVisible();

  await app.close();
  rmSync(cfg, { recursive: true, force: true });
});
