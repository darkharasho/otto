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
    displayTarget: 'cursor',
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

// A scripted assistant reply that gets streamed into the chat when the user
// hits enter on the seeded prompt. Uses unicode emojis so the README
// screenshot showcases Otto's rehype-emoji-icons pipeline (which maps each
// emoji grapheme to a Lucide icon).
const SCRIPTED_REPLY = [
  "🔍 Took a look at your audio stack — found a sample-rate mismatch.\n\n",
  "Discord is asking for **48 kHz** but PulseAudio's default sink is locked at **44.1 kHz**, so every callback is resampling on the fly. That's the cracking. 🔊\n\n",
  "Here's the fix:\n\n",
  "1. 🔧 Set `default-sample-rate = 48000` in `/etc/pulse/daemon.conf`\n",
  "2. 🔄 Restart PulseAudio (`systemctl --user restart pulseaudio`)\n",
  "3. ✅ Re-launch Discord — it'll lock to the new rate\n\n",
  "Want me to apply 1 and 2 now? The PulseAudio restart will momentarily drop any active streams. 🎧",
].join("");

// Init script: runs before any page script. Sets up window.otto.
const INIT_SCRIPT = `
const __sessions = ${JSON.stringify(SEED.sessions)};
const __settings = ${JSON.stringify(SEED.settings)};
const __mode = ${JSON.stringify(SEED.mode)};
const __approvalMessages = ${JSON.stringify(SEED.approvalMessages)};
const __reply = ${JSON.stringify(SCRIPTED_REPLY)};

let __sessionListener = null;
function __emit(ev) {
  if (__sessionListener) __sessionListener(ev);
}

window.otto = {
  invoke: async (channel, args) => {
    if (channel === 'session.list') return __sessions;
    if (channel === 'session.load') {
      if (args && args.sessionId === 'sess-1') return __approvalMessages;
      return [];
    }
    if (channel === 'autonomy.getMode') return __mode;
    if (channel === 'settings.get') return __settings;
    if (channel === 'session.start') return { sessionId: 'sess-conv' };
    if (channel === 'session.send') {
      // Stream a scripted reply so the panel shows a real conversation.
      const sessionId = (args && args.sessionId) || 'sess-conv';
      const messageId = 'msg-asst-' + Math.random().toString(36).slice(2, 8);
      Promise.resolve().then(async () => {
        __emit({ type: 'message-start', sessionId, messageId });
        // Stream in chunks so the renderer's text-delta path is exercised.
        const step = 24;
        for (let i = 0; i < __reply.length; i += step) {
          __emit({ type: 'text-delta', sessionId, messageId, text: __reply.slice(i, i + step) });
          await new Promise((r) => setTimeout(r, 5));
        }
        __emit({ type: 'message-end', sessionId, messageId });
        __emit({ type: 'done', sessionId });
      });
      return undefined;
    }
    if (channel === 'window.setMode') return undefined;
    if (channel === 'session.cancel') return undefined;
    return undefined;
  },
  onSessionEvent: (cb) => { __sessionListener = cb; return () => { __sessionListener = null; }; },
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

// Conversation: type a prompt, submit, let the mocked stream render the
// assistant reply (with emojis) in panel mode, then capture the panel.
await capture('conversation', '', { width: 720, height: 720 }, async (page) => {
  try {
    const input = page.locator('input, textarea').first();
    await input.waitFor({ timeout: 2000 });
    await input.click();
    await input.type('Discord audio cracks when I open games — diagnose and fix it', { delay: 8 });
    await input.press('Enter');
    // Wait for the panel to mount and the streamed reply to finish.
    await page.waitForTimeout(1200);
  } catch (err) {
    console.warn('  conversation: failed:', err.message);
  }
});

// Settings: the settings window UI.
await capture('settings', '#settings', { width: 520, height: 720 });

await browser.close();
server.close();

console.log(`Done — screenshots saved to ${OUT_DIR}`);
for (const f of fs.readdirSync(OUT_DIR)) console.log('  ', f);
