import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

test('autonomy: approve a destructive tool call', async () => {
  const cfg = mkdtempSync(path.join(tmpdir(), 'otto-autonomy-e2e-'));
  mkdirSync(path.join(cfg, 'otto'), { recursive: true });
  writeFileSync(
    path.join(cfg, 'otto', 'settings.json'),
    JSON.stringify({ version: 1, autonomy: { mode: 'balanced' } })
  );

  const app = await electron.launch({
    args: [path.join(process.cwd())],
    env: {
      ...process.env,
      OTTO_FAKE_SDK: '1',
      XDG_CONFIG_HOME: cfg,
      NODE_ENV: 'test',
    },
  });

  const page = await app.firstWindow();
  await page.waitForSelector('input[placeholder*="Ask Otto" i]');
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.show();
  });

  await page.fill('input[placeholder*="Ask Otto" i]', '[mutate] please');
  await page.press('input[placeholder*="Ask Otto" i]', 'Enter');

  await expect(page.getByText('fake-mutate').first()).toBeVisible({ timeout: 5000 });
  await page.getByRole('button', { name: /^approve$/i }).click();

  // After approval, the fake SDK emits tool-call-start + tool-call-result.
  // The resulting ToolCallCard renders the tool name; expand it to reveal the result.
  const toolCard = page.getByRole('button', { name: /fake-mutate/i }).last();
  await expect(toolCard).toBeVisible({ timeout: 5000 });
  await toolCard.click();
  await expect(page.getByText('Pretended to mutate X', { exact: false })).toBeVisible({ timeout: 5000 });

  await app.close();
  rmSync(cfg, { recursive: true, force: true });
});

test('autonomy: deny short-circuits the call', async () => {
  const cfg = mkdtempSync(path.join(tmpdir(), 'otto-autonomy-e2e-'));
  mkdirSync(path.join(cfg, 'otto'), { recursive: true });
  writeFileSync(
    path.join(cfg, 'otto', 'settings.json'),
    JSON.stringify({ version: 1, autonomy: { mode: 'balanced' } })
  );

  const app = await electron.launch({
    args: [path.join(process.cwd())],
    env: {
      ...process.env,
      OTTO_FAKE_SDK: '1',
      XDG_CONFIG_HOME: cfg,
      NODE_ENV: 'test',
    },
  });

  const page = await app.firstWindow();
  await page.waitForSelector('input[placeholder*="Ask Otto" i]');
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.show();
  });

  await page.fill('input[placeholder*="Ask Otto" i]', '[mutate] nope');
  await page.press('input[placeholder*="Ask Otto" i]', 'Enter');

  await expect(page.getByText('fake-mutate').first()).toBeVisible({ timeout: 5000 });
  await page.getByRole('button', { name: /^deny$/i }).click();

  await expect(page.getByText(/^denied$/i).first()).toBeVisible({ timeout: 3000 });
  await expect(page.getByText('Pretended to mutate X', { exact: false })).toHaveCount(0);

  await app.close();
  rmSync(cfg, { recursive: true, force: true });
});
