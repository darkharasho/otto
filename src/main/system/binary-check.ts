import { exec as execCb } from 'node:child_process';
import { promises as fsp } from 'node:fs';

function exec(cmd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execCb(cmd, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

export interface BinaryCheckOptions {
  /** Executable name to look for on PATH. */
  name: string;
  /** Human-readable use-case for error messages ("screen capture", "input injection", etc.). */
  purpose: string;
  /** Install command snippets keyed by distro family. `fallback` is required. */
  hints: {
    fedora?: string;
    debian?: string;
    arch?: string;
    fallback: string;
  };
}

export interface BinaryCheckResult {
  ok: boolean;
  path: string | null;
  reason: string | null;
  hint: string | null;
}

const cache = new Map<string, BinaryCheckResult>();
let distroFamily: 'fedora' | 'debian' | 'arch' | 'unknown' | null = null;

async function detectDistroFamily(): Promise<'fedora' | 'debian' | 'arch' | 'unknown'> {
  if (distroFamily) return distroFamily;
  try {
    const text = await fsp.readFile('/etc/os-release', 'utf8');
    const idLike = /^ID_LIKE="?([^"\n]+)"?/m.exec(text)?.[1] ?? '';
    const id = /^ID="?([^"\n]+)"?/m.exec(text)?.[1] ?? '';
    const haystack = `${id} ${idLike}`.toLowerCase();
    if (/\bfedora\b|\brhel\b|\bcentos\b/.test(haystack)) distroFamily = 'fedora';
    else if (/\bdebian\b|\bubuntu\b/.test(haystack)) distroFamily = 'debian';
    else if (/\barch\b/.test(haystack)) distroFamily = 'arch';
    else distroFamily = 'unknown';
  } catch {
    distroFamily = 'unknown';
  }
  return distroFamily;
}

/**
 * Check that a CLI binary is on PATH. Caches the success result for the
 * process lifetime; re-probes on failure so the user can fix mid-session.
 *
 * On failure, returns an actionable hint chosen by distro family.
 */
export async function checkBinary(opts: BinaryCheckOptions): Promise<BinaryCheckResult> {
  const cached = cache.get(opts.name);
  if (cached && cached.ok) return cached;

  try {
    const { stdout } = await exec(`which ${opts.name}`);
    const result: BinaryCheckResult = {
      ok: true,
      path: stdout.trim(),
      reason: null,
      hint: null,
    };
    cache.set(opts.name, result);
    return result;
  } catch {
    const family = await detectDistroFamily();
    const familyHint =
      family === 'fedora' ? opts.hints.fedora :
      family === 'debian' ? opts.hints.debian :
      family === 'arch' ? opts.hints.arch :
      undefined;
    const hint = familyHint ?? opts.hints.fallback;
    return {
      ok: false,
      path: null,
      reason: `${opts.name} is not installed (needed for ${opts.purpose})`,
      hint,
    };
  }
}

/** Test-only. */
export function _resetBinaryCheckCache(): void {
  cache.clear();
  distroFamily = null;
}
