/**
 * Packaged-aware voice asset path resolution.
 *
 * The pure functions here accept explicit flags/paths rather than reading from
 * Electron's `app` singleton directly, making them unit-testable without a
 * running Electron process. The thin `resolveWhisperBinary` / `whisperModelPath`
 * wrappers call `app.*` and delegate to those pure functions.
 */

import path from 'node:path';
import fs from 'node:fs';

export type WhisperModel = 'base.en' | 'small.en';

/**
 * Resolution result for a whisper model file. Task 2 (downloader) can use
 * `preferredPath` as the download destination and `exists` to decide whether
 * a download is needed.
 */
export interface WhisperModelResolution {
  /** The canonical (preferred) path — userData when packaged, userData or dev fallback. */
  preferredPath: string;
  /** Whether a file currently exists at `preferredPath`. */
  exists: boolean;
  /**
   * Resolved path to use right now (may differ from `preferredPath` when the
   * preferred file is absent and a dev fallback is present). Absent when
   * neither path has a file.
   */
  resolvedPath: string | null;
}

// ─── Pure helpers (injectable / testable) ─────────────────────────────────────

/**
 * Resolve the whisper-server binary path given injected Electron values.
 * In a packaged build the binary lives in `<resourcesPath>/voice/whisper-server`
 * (asarUnpacked via extraResources). In dev it lives under `resources/voice/`.
 */
export function resolveWhisperBinaryPure(opts: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}): string {
  if (opts.isPackaged) {
    return path.join(opts.resourcesPath, 'voice', 'whisper-server');
  }
  return path.join(opts.appPath, 'resources', 'voice', 'whisper-server');
}

/**
 * Resolve the whisper model path given injected Electron values.
 *
 * Priority:
 *  1. `<userData>/voice-models/whisper/ggml-<model>.bin` (preferred / download target)
 *  2. `<appPath>/resources/voice/models/ggml-<model>.bin` (dev fallback, only when not packaged)
 *
 * Returns a {@link WhisperModelResolution} so Task 2 can use `preferredPath`
 * as the download destination without repeating this logic.
 */
export function resolveWhisperModelPure(opts: {
  model: WhisperModel;
  isPackaged: boolean;
  appPath: string;
  userDataDir: string;
}): WhisperModelResolution {
  const filename = `ggml-${opts.model}.bin`;
  const preferredPath = path.join(opts.userDataDir, 'voice-models', 'whisper', filename);
  const preferredExists = fs.existsSync(preferredPath);

  if (preferredExists) {
    return { preferredPath, exists: true, resolvedPath: preferredPath };
  }

  // Not packaged: fall back to dev resources directory.
  if (!opts.isPackaged) {
    const devPath = path.join(opts.appPath, 'resources', 'voice', 'models', filename);
    if (fs.existsSync(devPath)) {
      return { preferredPath, exists: false, resolvedPath: devPath };
    }
  }

  // Neither path has the file.
  return { preferredPath, exists: false, resolvedPath: null };
}

// ─── Electron-reading wrappers ─────────────────────────────────────────────────

/**
 * Resolve the whisper-server binary path using Electron's `app` singleton.
 * Safe to call only after `app.ready`.
 */
export function resolveWhisperBinary(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { app } = require('electron') as typeof import('electron');
  return resolveWhisperBinaryPure({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
}

/**
 * Resolve the whisper model path using Electron's `app` singleton.
 * Safe to call only after `app.ready`.
 */
export function whisperModelPath(model: WhisperModel): WhisperModelResolution {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { app } = require('electron') as typeof import('electron');
  return resolveWhisperModelPure({
    model,
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    userDataDir: app.getPath('userData'),
  });
}
