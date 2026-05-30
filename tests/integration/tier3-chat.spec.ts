import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const hasDisplay = !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

test.skip(!hasDisplay, 'no display available');

test('tier 3 chat window: promote, drag, collapse, restore', async () => {
  const cfg = mkdtempSync(path.join(tmpdir(), 'otto-tier3-e2e-'));
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

  try {
    const page = await app.firstWindow();
    await page.waitForSelector('input[placeholder*="Ask Otto" i]');
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.show();
    });

    const input = page.locator('input[placeholder*="Ask Otto" i]');
    const getMode = () =>
      page.evaluate(
        () => document.querySelector('[data-window-mode]')?.getAttribute('data-window-mode') ?? 'none'
      );

    // Bar → panel
    await input.click();
    await page.waitForTimeout(200);
    expect(await getMode()).toBe('bar');
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(500);
    expect(await getMode()).toBe('panel');

    // Panel → chat
    await input.click();
    await page.waitForTimeout(200);
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(500);
    expect(await getMode()).toBe('chat');
    const chatHtml = await page.evaluate(() => document.body.innerHTML);
    expect(chatHtml).toContain('Coworking with Otto');

    // Move the OS window while in chat mode, then wait for the debounce to
    // persist the new bounds (250 ms in WindowManager + margin).
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setBounds({ x: 200, y: 200, width: 1000, height: 700 })
    );
    await page.waitForTimeout(500);

    // Chat → panel: renderer switches to panel mode (verified via DOM attribute).
    // OS-level repositioning to the bar/panel anchor is attempted by the main
    // process, but Wayland compositors may ignore setBounds on always-on-top
    // floating windows — so we only assert the renderer mode, not the pixel
    // position.
    await input.click();
    await page.waitForTimeout(200);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(500);
    expect(await getMode()).toBe('panel');

    // Panel → chat: WindowManager must restore the saved chat bounds.
    // On Wayland, setBounds IS honoured when the window is already at a valid
    // position accepted by the compositor — the chatBounds we persisted
    // (200, 200, 1000, 700) must be applied.
    await input.click();
    await page.waitForTimeout(200);
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(500);
    expect(await getMode()).toBe('chat');
    const chatBounds = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.getBounds()
    );
    expect(chatBounds.x).toBe(200);
    expect(chatBounds.y).toBe(200);
    expect(chatBounds.width).toBe(1000);
    expect(chatBounds.height).toBe(700);
  } finally {
    await app.close();
    rmSync(cfg, { recursive: true, force: true });
  }
});
