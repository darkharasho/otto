import { spawn } from 'node:child_process';
import type { DesktopEnv } from './detect';

/**
 * Best-effort deep-link into the DE's keyboard / shortcuts settings panel.
 * Tries each candidate command in order; the first one whose binary exists
 * and spawns without immediate error wins. Returns true if any candidate
 * launched, false if no known panel exists for this DE.
 */
export async function openKeyboardSettings(de: DesktopEnv): Promise<boolean> {
  const candidates = settingsCommands(de);
  for (const [bin, args] of candidates) {
    if (await trySpawn(bin, args)) return true;
  }
  return false;
}

function settingsCommands(de: DesktopEnv): Array<[string, string[]]> {
  switch (de) {
    case 'kde':
      // kcm_keys deep-links to the global shortcuts pane in Plasma 6.
      return [
        ['systemsettings', ['kcm_keys']],
        ['systemsettings5', ['kcm_keys']],
        ['kcmshell6', ['kcm_keys']],
        ['kcmshell5', ['kcm_keys']],
      ];
    case 'gnome':
      return [['gnome-control-center', ['keyboard']]];
    case 'cinnamon':
      return [['cinnamon-settings', ['keyboard']]];
    case 'mate':
      return [['mate-keybinding-properties', []]];
    case 'xfce':
      return [['xfce4-keyboard-settings', []]];
    case 'macos':
      // Deep-link into System Settings > Keyboard > Keyboard Shortcuts.
      return [['open', ['x-apple.systempreferences:com.apple.Keyboard-Settings.extension']]];
    case 'hyprland':
    case 'sway':
      // No GUI settings panel — these are config-file driven.
      return [];
    default:
      return [];
  }
}

function trySpawn(bin: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v: boolean) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    try {
      const child = spawn(bin, args, {
        detached: true,
        stdio: 'ignore',
      });
      child.on('error', () => settle(false));
      // If the process is still alive after a tick, consider the launch
      // successful — most GUI panels stay running. We unref so it can outlive
      // the main process.
      child.unref();
      setTimeout(() => settle(child.exitCode === null || child.exitCode === 0), 150);
    } catch {
      settle(false);
    }
  });
}
