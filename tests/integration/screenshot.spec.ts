import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const hasDisplay = !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

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

test('screenshot: capture renders inline and persists to disk', async () => {
  test.skip(!hasDisplay, 'no display server available (CI)');

  const cfg = mkdtempSync(path.join(tmpdir(), 'otto-screenshot-e2e-'));
  const app = await launch(cfg);
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('input[placeholder*="Ask Otto" i]');
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.show();
    });

    await page.fill('input[placeholder*="Ask Otto" i]', '[screenshot] please');
    await page.press('input[placeholder*="Ask Otto" i]', 'Enter');

    // ToolCallCard for 'screenshot' appears (the card button is prefixed with ⚙).
    const toolCard = page.getByRole('button', { name: /⚙\s*screenshot/i });
    await expect(toolCard).toBeVisible({ timeout: 10_000 });

    // Expand the card.
    await toolCard.click();

    // The inline image renders.
    const img = page.getByRole('img').first();
    await expect(img).toBeVisible({ timeout: 5_000 });
    const src = await img.getAttribute('src');
    expect(src).toMatch(/^file:\/\//);
    expect(src).toContain(`${cfg}/otto/screenshots/`);

    // The PNG exists on disk under the test's XDG_CONFIG_HOME.
    const filePath = src!.replace(/^file:\/\//, '');
    expect(existsSync(filePath)).toBe(true);
  } finally {
    await app.close();
    rmSync(cfg, { recursive: true, force: true });
  }
});
