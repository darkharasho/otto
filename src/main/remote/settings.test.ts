import { describe, it, expect } from 'vitest';
import { loadRemoteSettings, saveRemoteSettings, defaultRemoteSettings } from './settings';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('RemoteSettings', () => {
  it('returns defaults when no file exists', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'otto-rs-'));
    const settings = loadRemoteSettings(path.join(dir, 'remote.json'));
    expect(settings).toEqual(defaultRemoteSettings());
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips enabled + remoteCeiling', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'otto-rs-'));
    const file = path.join(dir, 'remote.json');
    saveRemoteSettings(file, { enabled: true, remoteCeiling: 'strict' });
    expect(loadRemoteSettings(file)).toEqual({ enabled: true, remoteCeiling: 'strict' });
    rmSync(dir, { recursive: true, force: true });
  });
});
