import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
    expect(written.version).toBe(3);
    expect(written.autonomy).toEqual({ mode: 'balanced' });
    expect(written.notifications).toEqual({ turnComplete: true, approval: true, sound: false });
    expect(written.startAtLogin).toBe(false);
    expect(written.windowPosition).toBe('bottom-center');
    expect(written.displayTarget).toBe('cursor');
    expect(written.autoDeleteDays).toBe(0);
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
    expect(written.version).toBe(3);
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
