// E2E proof of the privacy invariant: a /p conversation runs but leaves zero
// rows in the on-disk SQLite (sessions + messages) and is absent from history,
// while a normal message persists. Mirrors the smoke/screenshot specs.
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const hasDisplay = !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

function launch(cfg: string): Promise<ElectronApplication> {
  mkdirSync(path.join(cfg, 'otto'), { recursive: true });
  writeFileSync(
    path.join(cfg, 'otto', 'settings.json'),
    JSON.stringify({ version: 1, autonomy: { mode: 'balanced' } })
  );
  return electron.launch({
    args: [process.cwd()],
    env: {
      ...process.env,
      OTTO_FAKE_SDK: '1',
      XDG_CONFIG_HOME: cfg,
      NODE_ENV: 'test',
    },
  });
}

// Read row counts from the on-disk SQLite directly. Runs inside the Electron
// main process so better-sqlite3's native ABI matches the running app.
async function dbCounts(app: ElectronApplication, dbPath: string) {
  return app.evaluate(async (_electronModule, p) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3');
    const db = new Database(p, { readonly: true });
    const sessions = (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
    const messages = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    db.close();
    return { sessions, messages };
  }, dbPath);
}

test('private (/p): conversation runs but is never persisted to disk', async () => {
  test.skip(!hasDisplay, 'no display server available (CI)');

  const cfg = mkdtempSync(path.join(tmpdir(), 'otto-private-e2e-'));
  const app = await launch(cfg);
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('input[placeholder*="Ask Otto" i]');
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.show();
    });

    // Setting the whole value at once (like a real paste) and pressing Enter
    // routes through handleSubmit's private-prefix branch.
    await page.fill('input[placeholder*="Ask Otto" i]', '/p hello there');
    await page.press('input[placeholder*="Ask Otto" i]', 'Enter');

    // The private conversation actually runs (fake SDK echoes the prompt).
    await expect(page.getByTestId('message-user')).toContainText('hello there');
    await expect(page.getByTestId('message-assistant')).toContainText('echo: hello there', {
      timeout: 5000,
    });

    // ...but nothing about it touches durable storage.
    const counts = await dbCounts(app, path.join(cfg, 'otto', 'otto.db'));
    expect(counts).toEqual({ sessions: 0, messages: 0 });

    // ...and it is absent from history (session.list reads the sessions table).
    const sessions = await page.evaluate(
      () => (window as unknown as { otto: { invoke: (c: string, a: unknown) => Promise<unknown[]> } }).otto.invoke('session.list', undefined)
    );
    expect(sessions).toEqual([]);
  } finally {
    await app.close();
    rmSync(cfg, { recursive: true, force: true });
  }
});

test('normal message persists to disk (guards the private assertion)', async () => {
  test.skip(!hasDisplay, 'no display server available (CI)');

  const cfg = mkdtempSync(path.join(tmpdir(), 'otto-normal-e2e-'));
  const app = await launch(cfg);
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('input[placeholder*="Ask Otto" i]');
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.show();
    });

    await page.fill('input[placeholder*="Ask Otto" i]', 'hello there');
    await page.press('input[placeholder*="Ask Otto" i]', 'Enter');

    await expect(page.getByTestId('message-assistant')).toContainText('echo: hello there', {
      timeout: 5000,
    });

    const counts = await dbCounts(app, path.join(cfg, 'otto', 'otto.db'));
    expect(counts.sessions).toBe(1);
    expect(counts.messages).toBeGreaterThanOrEqual(2); // user + assistant
  } finally {
    await app.close();
    rmSync(cfg, { recursive: true, force: true });
  }
});
