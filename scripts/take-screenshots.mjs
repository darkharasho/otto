#!/usr/bin/env node
// Capture README screenshots for Otto by loading the built renderer in
// headless Chromium with a mocked window.otto bridge. This avoids the
// complexity of driving the full Electron app with its real DB, IPC, and
// system tray.
//
// Usage:
//   npm run build && node scripts/take-screenshots.mjs
//
// Output: public/img/screenshots/{hero,settings}.png

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'public', 'img', 'screenshots');
fs.mkdirSync(OUT_DIR, { recursive: true });

const RENDERER_DIR = path.join(ROOT, 'out', 'renderer');
if (!fs.existsSync(path.join(RENDERER_DIR, 'index.html'))) {
  console.error(`Renderer build missing at ${RENDERER_DIR}. Run \`npm run build\` first.`);
  process.exit(1);
}

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let p = path.join(RENDERER_DIR, decodeURIComponent(url.pathname));
  if (!p.startsWith(RENDERER_DIR)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(RENDERER_DIR, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}/index.html`;

// Sample seed data so the rendered UI isn't empty. We mock just enough of
// window.otto for the React app to mount and render meaningful content.
const now = Date.now();
const SEED = {
  sessions: [
    { id: 'sess-1', title: 'Discord audio crackle', createdAt: now - 60000, lastActive: now - 60000, model: 'claude-sonnet-4-6', status: 'active', sdkSessionId: null },
    { id: 'sess-2', title: 'Why is steam using 40% CPU?', createdAt: now - 600000, lastActive: now - 600000, model: 'claude-sonnet-4-6', status: 'idle', sdkSessionId: null },
    { id: 'sess-3', title: 'Set up backups for ~/dev', createdAt: now - 86400000, lastActive: now - 86400000, model: 'claude-sonnet-4-6', status: 'ended', sdkSessionId: null },
  ],
  mode: 'balanced',
  settings: {
    autonomy: { mode: 'balanced' },
    notifications: { turnComplete: true, approval: true, sound: false },
    startAtLogin: false,
    windowPosition: 'bottom-center',
    autoDeleteDays: 30,
    version: '0.1.0',
  },
  // Approval-flow seeded messages for sess-1.
  approvalMessages: [
    {
      id: 'm1', sessionId: 'sess-1', seq: 1, createdAt: now - 50000, role: 'user',
      content: [{ type: 'text', text: 'Discord audio cracks when I open games — diagnose and fix it' }],
    },
    {
      id: 'm2', sessionId: 'sess-1', seq: 2, createdAt: now - 48000, role: 'assistant',
      cancelled: false, errored: false,
      content: [
        { type: 'text', text: "I'll check the active audio devices and PulseAudio's current sample rate to see if there's a mismatch with what Discord is requesting." },
        {
          type: 'pending_tool_use',
          callId: 'call_1',
          decisionId: 'dec_1',
          name: 'shell',
          input: { command: 'pactl list sinks short && pactl info | grep -i sample' },
          actionClass: 'read',
          reason: 'Read-only — lists current audio devices and the configured sample rate.',
          decision: 'pending',
        },
      ],
    },
  ],
};

// Init script: runs before any page script. Sets up window.otto.
const INIT_SCRIPT = `
const __sessions = ${JSON.stringify(SEED.sessions)};
const __settings = ${JSON.stringify(SEED.settings)};
const __mode = ${JSON.stringify(SEED.mode)};
const __approvalMessages = ${JSON.stringify(SEED.approvalMessages)};
window.otto = {
  invoke: async (channel, args) => {
    if (channel === 'session.list') return __sessions;
    if (channel === 'session.load') {
      if (args && args.sessionId === 'sess-1') return __approvalMessages;
      return [];
    }
    if (channel === 'autonomy.getMode') return __mode;
    if (channel === 'settings.get') return __settings;
    if (channel === 'session.start') return { sessionId: 'sess-new' };
    if (channel === 'session.send') return undefined;
    if (channel === 'window.setMode') return undefined;
    return undefined;
  },
  onSessionEvent: () => () => {},
  onAutonomyEvent: () => () => {},
  updater: {
    status: async () => ({ kind: 'idle' }),
    check: async () => ({ kind: 'idle' }),
    download: async () => ({ kind: 'idle' }),
    install: async () => {},
    onStateChange: () => () => {},
  },
};
`;

const browser = await chromium.launch({ headless: true });

async function capture(name, hash, viewport, prepare) {
  console.log(`Capturing ${name}...`);
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  await ctx.addInitScript(INIT_SCRIPT);
  const page = await ctx.newPage();
  page.on('pageerror', (err) => console.error('  PAGE ERROR:', err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      console.error('  CONSOLE', msg.type(), ':', msg.text());
    }
  });
  await page.goto(`${baseUrl}${hash}`);
  await page.waitForLoadState('domcontentloaded');
  // The real Otto window is transparent (frame: false, transparent: true).
  // Strip body/html backgrounds so the screenshot preserves alpha.
  await page.addStyleTag({
    content: 'html, body, #root { background: transparent !important; }',
  });
  // Let React mount and effects fire.
  await page.waitForTimeout(800);
  if (prepare) await prepare(page);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), omitBackground: true });
  await ctx.close();
}

// Hero: main command bar with a sample prompt typed. Tight bar height.
await capture('hero', '', { width: 720, height: 96 }, async (page) => {
  try {
    const input = page.locator('input, textarea').first();
    await input.waitFor({ timeout: 2000 });
    await input.click();
    await input.type('Discord audio cracks when I open games — diagnose and fix it', { delay: 12 });
  } catch (err) {
    console.warn('  hero: could not type into input:', err.message);
  }
});

// Settings: the settings window UI.
await capture('settings', '#settings', { width: 520, height: 720 });

await browser.close();
server.close();

console.log(`Done — screenshots saved to ${OUT_DIR}`);
for (const f of fs.readdirSync(OUT_DIR)) console.log('  ', f);
