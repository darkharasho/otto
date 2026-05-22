import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

async function launch(cfg: string) {
  mkdirSync(path.join(cfg, 'otto'), { recursive: true });
  writeFileSync(
    path.join(cfg, 'otto', 'settings.json'),
    JSON.stringify({ version: 1, autonomy: { mode: 'balanced' } })
  );
  return electron.launch({
    args: [path.join(process.cwd())],
    env: {
      ...process.env,
      OTTO_FAKE_SDK: '1',
      XDG_CONFIG_HOME: cfg,
      NODE_ENV: 'test',
    },
  });
}

test('shell: approve shell.exec, see stdout in result', async () => {
  const cfg = mkdtempSync(path.join(tmpdir(), 'otto-shell-exec-e2e-'));
  const app = await launch(cfg);
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('input[placeholder*="Ask Otto" i]');
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.show();
    });

    await page.fill('input[placeholder*="Ask Otto" i]', '[shell] please');
    await page.press('input[placeholder*="Ask Otto" i]', 'Enter');

    // Approval card for shell.exec — first() because the same name may appear
    // in multiple places once decided.
    await expect(page.getByText('shell.exec').first()).toBeVisible({ timeout: 5_000 });
    await page.getByRole('button', { name: /^approve$/i }).click();

    // Expand the ToolCallCard to see result.
    await page.getByRole('button', { name: /shell\.exec/i }).first().click();
    await expect(page.getByText(/hi/).first()).toBeVisible({ timeout: 5_000 });
  } finally {
    await app.close();
    rmSync(cfg, { recursive: true, force: true });
  }
});

test('shell: approve shell.spawn, ProcessCard appears, Cancel kills it', async () => {
  const cfg = mkdtempSync(path.join(tmpdir(), 'otto-shell-spawn-e2e-'));
  const app = await launch(cfg);
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('input[placeholder*="Ask Otto" i]');
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.show();
    });

    await page.fill('input[placeholder*="Ask Otto" i]', '[spawn] please');
    await page.press('input[placeholder*="Ask Otto" i]', 'Enter');

    await expect(page.getByText('shell.spawn').first()).toBeVisible({ timeout: 5_000 });
    await page.getByRole('button', { name: /^approve$/i }).click();

    // ProcessCard renders (use exact match to disambiguate from the
    // ToolCallCard JSON serialization of the input).
    await expect(page.getByText('sleep 10', { exact: true })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/running/i).first()).toBeVisible();

    await page.getByRole('button', { name: /cancel/i }).click();
    await expect(page.getByText(/killed/i).first()).toBeVisible({ timeout: 3_000 });
  } finally {
    await app.close();
    rmSync(cfg, { recursive: true, force: true });
  }
});
