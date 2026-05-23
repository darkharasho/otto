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

/**
 * Candidate systemd units. Different distros package the daemon differently:
 * - Debian/Arch: user service `ydotoold.service` (no sudo to start)
 * - Fedora/Bazzite: system service `ydotool.service` (sudo required)
 *
 * We probe each in order. Auto-enable is only attempted for user-scope units
 * since the system scope requires elevated privileges.
 */
interface UnitProbe {
  /** Friendly name used in error hints. */
  label: string;
  /** Systemctl scope flag (e.g. '--user' or empty for system). */
  scope: string;
  /** Unit name (without .service suffix). */
  unit: string;
  /** Whether `systemctl <scope> enable --now <unit>` can run without sudo. */
  autoEnableable: boolean;
}

const PROBES: UnitProbe[] = [
  { label: 'ydotoold (user)', scope: '--user', unit: 'ydotoold', autoEnableable: true },
  { label: 'ydotool (system)', scope: '', unit: 'ydotool', autoEnableable: false },
];

const INSTALL_HINT = 'Install on Fedora/Bazzite: sudo dnf install ydotool';

export async function checkYdotoolReady(): Promise<SetupResult> {
  if (cached && cached.ok) return cached;

  try {
    await exec('which ydotool');
  } catch {
    cached = null;
    return { ok: false, reason: 'ydotool is not installed', hint: INSTALL_HINT };
  }

  // Probe each candidate unit. First one that is active wins.
  for (const probe of PROBES) {
    if (await probeActive(probe)) {
      cached = { ok: true, reason: null, hint: null };
      return cached;
    }
  }

  // None active. Try to auto-enable any unit that doesn't need sudo.
  for (const probe of PROBES) {
    if (!probe.autoEnableable) continue;
    try {
      await exec(`systemctl ${probe.scope} enable --now ${probe.unit}`);
    } catch {
      continue;
    }
    await sleep(500);
    if (await probeActive(probe)) {
      cached = { ok: true, reason: null, hint: null };
      return cached;
    }
  }

  cached = null;
  return {
    ok: false,
    reason: 'ydotool daemon is not running',
    hint: [
      'On Fedora/Bazzite (system service):',
      '  sudo systemctl enable --now ydotool',
      '',
      'On Debian/Arch (user service):',
      '  systemctl --user enable --now ydotoold',
      '',
      'Then make sure your user is in the input group:',
      '  sudo usermod -aG input $USER',
      '  (log out + back in)',
    ].join('\n'),
  };
}

async function probeActive(probe: UnitProbe): Promise<boolean> {
  try {
    const scopeArg = probe.scope ? `${probe.scope} ` : '';
    const { stdout } = await exec(`systemctl ${scopeArg}is-active ${probe.unit}`);
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
