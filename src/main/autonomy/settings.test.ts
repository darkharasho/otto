import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import os from 'node:os';
import path from 'node:path';
import { Settings } from './settings';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'otto-settings-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function settingsPath(): string {
  return path.join(dir, 'settings.json');
}

describe('Settings.load', () => {
  it('returns defaults when file is missing and writes a fresh defaults file', async () => {
    const s = new Settings(settingsPath());
    await s.load();
    expect(s.getMode()).toBe('balanced');
    const written = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    expect(written.version).toBe(5);
    expect(written.autonomy).toEqual({ mode: 'balanced' });
    expect(written.notifications).toEqual({ turnComplete: true, approval: true, sound: false });
    expect(written.startAtLogin).toBe(false);
    expect(written.windowPosition).toBe('bottom-center');
    expect(written.displayTarget).toBe('cursor');
    expect(written.autoDeleteDays).toBe(0);
    expect(written.showReasoning).toBe(true);
    expect(s.getShowReasoning()).toBe(true);
    expect(written.chatBounds).toBeNull();
    expect(written.lastVisibleMode).toBe('bar');
    expect(written.pinnedSessionIds).toEqual([]);
  });

  it('migrates a v2 file forward, defaulting displayTarget to cursor', async () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        version: 2,
        autonomy: { mode: 'strict' },
        notifications: { turnComplete: true, approval: true, sound: false },
        startAtLogin: false,
        windowPosition: 'bottom-center',
        autoDeleteDays: 0,
        hideOnBlur: false,
      })
    );
    const s = new Settings(settingsPath());
    await s.load();
    expect(s.getDisplayTarget()).toBe('cursor');
    const written = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    expect(written.version).toBe(5);
    expect(written.displayTarget).toBe('cursor');
  });

  it('returns existing mode from a v1 file', async () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({ version: 1, autonomy: { mode: 'strict' } })
    );
    const s = new Settings(settingsPath());
    await s.load();
    expect(s.getMode()).toBe('strict');
  });

  it('returns defaults and warns on malformed JSON', async () => {
    writeFileSync(settingsPath(), '{not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = new Settings(settingsPath());
    await s.load();
    expect(s.getMode()).toBe('balanced');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns defaults and warns on unknown future version', async () => {
    writeFileSync(settingsPath(), JSON.stringify({ version: 99, autonomy: { mode: 'strict' } }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = new Settings(settingsPath());
    await s.load();
    expect(s.getMode()).toBe('balanced');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('Settings.setMode', () => {
  it('persists atomically and fires onChange listeners', async () => {
    const s = new Settings(settingsPath());
    await s.load();
    const events: string[] = [];
    const unsub = s.onChange((snap) => events.push(snap.autonomy.mode));
    await s.setMode('strict');
    expect(s.getMode()).toBe('strict');
    expect(events).toEqual(['strict']);
    const written = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    expect(written.autonomy.mode).toBe('strict');
    unsub();
    await s.setMode('full-allow');
    expect(events).toEqual(['strict']);
  });
});

describe('Settings — newConversation', () => {
  it('defaults idleTimeoutMinutes to 60 on fresh install', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-settings-nc-'));
    const s = new Settings(path.join(dir, 'settings.json'));
    await s.load();
    expect(s.getNewConversationIdleTimeoutMinutes()).toBe(60);
  });

  it('migrates a v3 file by adding the default idleTimeoutMinutes=60', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-settings-nc-'));
    const file = path.join(dir, 'settings.json');
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 3,
        autonomy: { mode: 'balanced' },
        notifications: { turnComplete: true, approval: true, sound: false },
        startAtLogin: false,
        windowPosition: 'bottom-center',
        displayTarget: 'cursor',
        autoDeleteDays: 0,
        hideOnBlur: false,
      }),
    );
    const s = new Settings(file);
    await s.load();
    expect(s.getNewConversationIdleTimeoutMinutes()).toBe(60);
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(raw.version).toBe(5);
    expect(raw.newConversation).toEqual({ idleTimeoutMinutes: 60 });
  });

  it('setNewConversationIdleTimeoutMinutes persists and rejects negatives', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-settings-nc-'));
    const s = new Settings(path.join(dir, 'settings.json'));
    await s.load();
    await s.setNewConversationIdleTimeoutMinutes(120);
    expect(s.getNewConversationIdleTimeoutMinutes()).toBe(120);
    await expect(s.setNewConversationIdleTimeoutMinutes(-1)).rejects.toThrow();
  });

  it('accepts 0 to disable idle-based new conversations', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-settings-nc-'));
    const s = new Settings(path.join(dir, 'settings.json'));
    await s.load();
    await s.setNewConversationIdleTimeoutMinutes(0);
    expect(s.getNewConversationIdleTimeoutMinutes()).toBe(0);
  });
});
