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
    expect(written.version).toBe(9);
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
    expect(written.version).toBe(9);
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

describe('Settings — v8→v9 migration (idle new-conversation removal)', () => {
  it('migrates a v8 file and drops the newConversation field', async () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        version: 8,
        autonomy: { mode: 'balanced' },
        notifications: { turnComplete: true, approval: true, sound: false },
        startAtLogin: false,
        windowPosition: 'bottom-center',
        displayTarget: 'cursor',
        autoDeleteDays: 0,
        hideOnBlur: false,
        showReasoning: true,
        newConversation: { idleTimeoutMinutes: 60 },
        chatBounds: null,
        lastVisibleMode: 'bar',
        pinnedSessionIds: [],
        voice: { ttsVoice: 'af_heart', speed: 1.05, whisperModel: 'small.en', endpointMs: 650 },
      })
    );
    const s = new Settings(settingsPath());
    await s.load();
    expect(s.getMode()).toBe('balanced');
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    expect(raw.version).toBe(9);
    expect('newConversation' in raw).toBe(false);
  });
});

describe('Settings — voice prefs (v5→v6 migration)', () => {
  it('defaults ttsVoice=af_heart and speed=1.05 on fresh install', async () => {
    const s = new Settings(settingsPath());
    await s.load();
    expect(s.getVoicePrefs()).toEqual({ ttsVoice: 'af_heart', speed: 1.05, whisperModel: 'small.en', endpointMs: 650 });
    const written = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    expect(written.version).toBe(9);
    expect(written.voice).toEqual({ ttsVoice: 'af_heart', speed: 1.05, whisperModel: 'small.en', endpointMs: 650 });
  });

  it('migrates a v5 file to v6 with default voice prefs', async () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        version: 5,
        autonomy: { mode: 'balanced' },
        notifications: { turnComplete: true, approval: true, sound: false },
        startAtLogin: false,
        windowPosition: 'bottom-center',
        displayTarget: 'cursor',
        autoDeleteDays: 0,
        hideOnBlur: false,
        showReasoning: true,
        newConversation: { idleTimeoutMinutes: 60 },
        chatBounds: null,
        lastVisibleMode: 'bar',
        pinnedSessionIds: [],
      })
    );
    const s = new Settings(settingsPath());
    await s.load();
    expect(s.getVoicePrefs()).toEqual({ ttsVoice: 'af_heart', speed: 1.05, whisperModel: 'small.en', endpointMs: 650 });
    const written = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    expect(written.version).toBe(9);
  });

  it('setVoicePrefs persists partial update', async () => {
    const s = new Settings(settingsPath());
    await s.load();
    await s.setVoicePrefs({ ttsVoice: 'bm_george' });
    expect(s.getVoicePrefs()).toEqual({ ttsVoice: 'bm_george', speed: 1.05, whisperModel: 'small.en', endpointMs: 650 });
    const written = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    expect(written.voice.ttsVoice).toBe('bm_george');
    expect(written.voice.speed).toBe(1.05);
  });
});

describe('Settings — v7→v8 migration (topic-shift removal)', () => {
  it('migrates a v7 file and drops the topicShiftSensitivity field', async () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        version: 7,
        autonomy: { mode: 'balanced' },
        notifications: { turnComplete: true, approval: true, sound: false },
        startAtLogin: false,
        windowPosition: 'bottom-center',
        displayTarget: 'cursor',
        autoDeleteDays: 0,
        hideOnBlur: false,
        showReasoning: true,
        newConversation: { idleTimeoutMinutes: 60 },
        chatBounds: null,
        lastVisibleMode: 'bar',
        pinnedSessionIds: [],
        voice: { ttsVoice: 'af_heart', speed: 1.05, whisperModel: 'small.en', endpointMs: 650 },
        topicShiftSensitivity: 'high',
      })
    );
    const s = new Settings(settingsPath());
    await s.load();
    expect(s.getMode()).toBe('balanced');
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    expect(raw.version).toBe(9);
    expect('topicShiftSensitivity' in raw).toBe(false);
  });
});
