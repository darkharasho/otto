import { exec as execCb } from 'node:child_process';

function exec(cmd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execCb(cmd, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

export interface SetupResult {
  ok: boolean;
  reason: string | null;
  hint: string | null;
}

let cached: SetupResult | null = null;

const INSTALL_HINT = 'Install on Fedora/Bazzite: sudo dnf install ydotool';
const START_HINT = 'Try manually: systemctl --user enable --now ydotoold';

export async function checkYdotoolReady(): Promise<SetupResult> {
  if (cached && cached.ok) return cached;

  try {
    await exec('which ydotool');
  } catch {
    cached = null;
    return { ok: false, reason: 'ydotool is not installed', hint: INSTALL_HINT };
  }

  if (await probeActive()) {
    cached = { ok: true, reason: null, hint: null };
    return cached;
  }

  try {
    await exec('systemctl --user enable --now ydotoold');
  } catch {
    // continue to re-poll
  }
  await sleep(500);

  if (await probeActive()) {
    cached = { ok: true, reason: null, hint: null };
    return cached;
  }

  cached = null;
  return {
    ok: false,
    reason: 'ydotoold service is not running and could not be started automatically',
    hint: START_HINT,
  };
}

async function probeActive(): Promise<boolean> {
  try {
    const { stdout } = await exec('systemctl --user is-active ydotoold');
    return stdout.trim() === 'active';
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function _resetCacheForTesting(): void {
  cached = null;
}
