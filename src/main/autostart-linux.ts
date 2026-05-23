import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from './logger';
import { instanceDisplayName, instanceSuffix } from './instance';

// Electron's app.setLoginItemSettings is a no-op on Linux. The XDG-standard
// way to autostart a desktop app is a .desktop file under ~/.config/autostart.
// We honor $XDG_CONFIG_HOME when set so this works on systems that relocate
// the user config dir.
function autostartFilePath(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'autostart', `otto${instanceSuffix()}.desktop`);
}

// Prefer the original AppImage path so the autostart entry survives version
// upgrades that replace the mounted squashfs exec. Falls back to execPath for
// deb/rpm/tarball installs.
function execTarget(): string {
  return process.env.APPIMAGE || process.execPath;
}

function desktopFileContents(): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${instanceDisplayName()}`,
    'Comment=General-purpose computer coworking agent',
    `Exec=${execTarget()}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

export function applyLinuxAutostart(enabled: boolean): void {
  const target = autostartFilePath();
  try {
    if (enabled) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, desktopFileContents(), { mode: 0o644 });
      logger.info(`autostart enabled at ${target}`);
    } else if (fs.existsSync(target)) {
      fs.unlinkSync(target);
      logger.info(`autostart disabled (removed ${target})`);
    }
  } catch (err) {
    logger.warn(`linux autostart update failed: ${err instanceof Error ? err.message : err}`);
  }
}
