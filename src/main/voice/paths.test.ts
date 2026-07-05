// src/main/voice/paths.test.ts
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { resolveWhisperBinaryPure, resolveWhisperModelPure } from './paths';

// ─── resolveWhisperBinaryPure ─────────────────────────────────────────────────

describe('resolveWhisperBinaryPure', () => {
  it('returns resourcesPath/voice/whisper-server when packaged', () => {
    const result = resolveWhisperBinaryPure({
      isPackaged: true,
      resourcesPath: '/opt/app/resources',
      appPath: '/opt/app/resources/app.asar',
    });
    expect(result).toBe(path.join('/opt/app/resources', 'voice', 'whisper-server'));
  });

  it('returns appPath/resources/voice/whisper-server when not packaged', () => {
    const result = resolveWhisperBinaryPure({
      isPackaged: false,
      resourcesPath: '',
      appPath: '/home/dev/otto',
    });
    expect(result).toBe(path.join('/home/dev/otto', 'resources', 'voice', 'whisper-server'));
  });
});

// ─── resolveWhisperModelPure ──────────────────────────────────────────────────

describe('resolveWhisperModelPure', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-voice-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function userDataDir(): string {
    return path.join(tmpDir, 'userData');
  }

  function devAppPath(): string {
    return path.join(tmpDir, 'appPath');
  }

  function makeUserDataModel(model: string): string {
    const dir = path.join(userDataDir(), 'voice-models', 'whisper');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `ggml-${model}.bin`);
    fs.writeFileSync(p, 'fake');
    return p;
  }

  function makeDevModel(model: string): string {
    const dir = path.join(devAppPath(), 'resources', 'voice', 'models');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `ggml-${model}.bin`);
    fs.writeFileSync(p, 'fake');
    return p;
  }

  it('resolves to userData path when model exists there (packaged)', () => {
    const udPath = makeUserDataModel('base.en');
    const result = resolveWhisperModelPure({
      model: 'base.en',
      isPackaged: true,
      appPath: devAppPath(),
      userDataDir: userDataDir(),
    });
    expect(result.exists).toBe(true);
    expect(result.resolvedPath).toBe(udPath);
    expect(result.preferredPath).toBe(udPath);
  });

  it('resolves to userData path when model exists there (dev)', () => {
    const udPath = makeUserDataModel('small.en');
    // also put a dev model — userData should win
    makeDevModel('small.en');
    const result = resolveWhisperModelPure({
      model: 'small.en',
      isPackaged: false,
      appPath: devAppPath(),
      userDataDir: userDataDir(),
    });
    expect(result.exists).toBe(true);
    expect(result.resolvedPath).toBe(udPath);
  });

  it('falls back to dev resources when userData model absent and not packaged', () => {
    const devPath = makeDevModel('base.en');
    const result = resolveWhisperModelPure({
      model: 'base.en',
      isPackaged: false,
      appPath: devAppPath(),
      userDataDir: userDataDir(),
    });
    expect(result.exists).toBe(false);
    expect(result.resolvedPath).toBe(devPath);
    // preferredPath still points to userData (download destination for Task 2)
    expect(result.preferredPath).toContain('voice-models');
  });

  it('returns resolvedPath=null when no model exists (packaged)', () => {
    const result = resolveWhisperModelPure({
      model: 'base.en',
      isPackaged: true,
      appPath: devAppPath(),
      userDataDir: userDataDir(),
    });
    expect(result.exists).toBe(false);
    expect(result.resolvedPath).toBeNull();
  });

  it('returns resolvedPath=null when no model exists anywhere (dev)', () => {
    const result = resolveWhisperModelPure({
      model: 'small.en',
      isPackaged: false,
      appPath: devAppPath(),
      userDataDir: userDataDir(),
    });
    expect(result.exists).toBe(false);
    expect(result.resolvedPath).toBeNull();
  });

  it('does NOT check dev fallback when packaged even if dev file exists', () => {
    // Dev file present but packaged=true — no fallback allowed.
    makeDevModel('base.en');
    const result = resolveWhisperModelPure({
      model: 'base.en',
      isPackaged: true,
      appPath: devAppPath(),
      userDataDir: userDataDir(),
    });
    expect(result.resolvedPath).toBeNull();
  });
});
