/**
 * Whisper model downloader.
 *
 * Downloads a whisper model from Hugging Face (ggerganov/whisper.cpp) to a
 * local path, using a `.part` temp file + atomic rename so a partial download
 * never leaves an unusable file at the destination.
 *
 * Progress callbacks are throttled to whole-percent steps to keep IPC noise
 * low.
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import type { WhisperModel } from './paths';

const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

/** Minimum file size (bytes) before the rename succeeds. Overridable for tests. */
export const DEFAULT_MIN_BYTES = 100 * 1024 * 1024; // 100 MB

/** How long (ms) to wait without receiving any data before aborting a stalled download. */
export const INACTIVITY_TIMEOUT_MS = 30_000;

/**
 * Returns the canonical HuggingFace download URL for a given model.
 * Exported for testing.
 */
export function whisperModelUrl(model: WhisperModel): string {
  return `${HF_BASE}/ggml-${model}.bin`;
}

/**
 * Ensure the whisper model file exists at `destPath`.
 *
 * - If `destPath` already exists, returns immediately (idempotent).
 * - Downloads via `.part` temp file; renames atomically on success.
 * - Calls `onProgress` with integer 0–100. Throttled to whole-percent steps.
 * - Verifies file size >= `minBytes` before rename (sanity check).
 * - Cleans up the `.part` file on any failure.
 *
 * @param model        Model key, e.g. `'small.en'`
 * @param destPath     Full path to write the model binary.
 * @param onProgress   Called with integer 0–100 as download progresses.
 * @param minBytes     Minimum acceptable file size; defaults to 100 MB.
 * @param urlOverride  Override the download URL (for testing against a local server).
 */
export async function ensureWhisperModel(
  model: WhisperModel,
  destPath: string,
  onProgress: (pct: number) => void,
  minBytes = DEFAULT_MIN_BYTES,
  urlOverride?: string,
): Promise<void> {
  // Idempotent: if the file already exists, nothing to do.
  if (fs.existsSync(destPath)) return;

  const partPath = `${destPath}.part`;
  const url = urlOverride ?? whisperModelUrl(model);

  // Ensure the destination directory exists.
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  try {
    await download(url, partPath, onProgress);

    // Sanity-check file size.
    const stat = fs.statSync(partPath);
    if (stat.size < minBytes) {
      throw new Error(
        `Downloaded file is too small (${stat.size} bytes < expected minimum ${minBytes}). ` +
          `The file may be corrupt or the URL may be wrong.`,
      );
    }

    // Atomic rename.
    fs.renameSync(partPath, destPath);
  } catch (err) {
    // Clean up the partial file on any failure.
    try {
      if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

/**
 * Download a URL to a file path, calling onProgress with whole-percent steps.
 * Follows HTTP 301/302/307/308 redirects (up to 5 hops).
 */
function download(
  url: string,
  destPath: string,
  onProgress: (pct: number) => void,
  redirectsLeft = 5,
  inactivityMs = INACTIVITY_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;

    const req = transport.get(url, (res) => {
      // Follow redirects.
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        if (redirectsLeft <= 0) {
          reject(new Error(`Too many redirects downloading ${url}`));
          return;
        }
        const next = new URL(res.headers.location, url).href;
        resolve(download(next, destPath, onProgress, redirectsLeft - 1, inactivityMs));
        return;
      }

      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`HTTP ${res.statusCode ?? 'unknown'} downloading ${url}`));
        return;
      }

      const total = parseInt(res.headers['content-length'] ?? '0', 10);
      let received = 0;
      let lastPct = -1;

      const out = fs.createWriteStream(destPath);

      // Inactivity watchdog: if no data arrives within inactivityMs, destroy the
      // request so a stalled download doesn't hang the serialized setMode chain.
      let inactivityTimer = setTimeout(() => {
        req.destroy(new Error(`Download stalled: no data for ${inactivityMs}ms from ${url}`));
      }, inactivityMs);

      const resetTimer = (): void => {
        clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          req.destroy(new Error(`Download stalled: no data for ${inactivityMs}ms from ${url}`));
        }, inactivityMs);
      };

      res.on('data', (chunk: Buffer) => {
        resetTimer();
        received += chunk.length;
        if (total > 0) {
          const pct = Math.floor((received / total) * 100);
          if (pct !== lastPct) {
            lastPct = pct;
            onProgress(pct);
          }
        }
      });

      res.pipe(out);

      out.on('finish', () => {
        clearTimeout(inactivityTimer);
        // Ensure we always fire 100% on completion.
        if (lastPct !== 100) onProgress(100);
        resolve();
      });

      out.on('error', (err) => {
        clearTimeout(inactivityTimer);
        reject(err);
      });

      res.on('error', (err) => {
        clearTimeout(inactivityTimer);
        reject(err);
      });
    });

    req.on('error', (err) => {
      reject(err);
    });
  });
}
