/**
 * Pure detection of the user's desktop environment + display server. Keeps
 * env-string parsing in one spot so the rest of the shortcut module can branch
 * on stable enum values.
 */

export type DesktopEnv =
  | 'kde'
  | 'gnome'
  | 'xfce'
  | 'cinnamon'
  | 'mate'
  | 'hyprland'
  | 'sway'
  | 'macos'
  | 'other'
  | 'unknown';

export type DisplayServer = 'x11' | 'wayland' | 'unknown';

export function detectDesktopEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): DesktopEnv {
  if (platform === 'darwin') return 'macos';

  // XDG_CURRENT_DESKTOP is a colon-separated list of "current" desktops. We
  // match on the first recognized token. DESKTOP_SESSION is a fallback for
  // older or unusual setups.
  const tokens = [
    ...(env.XDG_CURRENT_DESKTOP ?? '').split(':'),
    env.DESKTOP_SESSION ?? '',
  ]
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  for (const t of tokens) {
    if (t === 'kde' || t.includes('plasma')) return 'kde';
    if (t === 'gnome' || t === 'gnome-classic' || t === 'unity') return 'gnome';
    if (t.includes('xfce')) return 'xfce';
    if (t.includes('cinnamon')) return 'cinnamon';
    if (t.includes('mate')) return 'mate';
    if (t.includes('hyprland')) return 'hyprland';
    if (t.includes('sway')) return 'sway';
  }
  return tokens.length > 0 ? 'other' : 'unknown';
}

export function detectDisplayServer(env: NodeJS.ProcessEnv = process.env): DisplayServer {
  const s = (env.XDG_SESSION_TYPE ?? '').toLowerCase();
  if (s === 'wayland') return 'wayland';
  if (s === 'x11') return 'x11';
  return 'unknown';
}

/**
 * True only for desktops where we have an implementation that can register a
 * global shortcut without user intervention. Currently KDE only.
 */
export function supportsAutoRegister(de: DesktopEnv): boolean {
  return de === 'kde';
}
