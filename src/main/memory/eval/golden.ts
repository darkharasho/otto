/**
 * Golden set for the offline recall-quality eval. Hand-built to look like a
 * real Otto memory store on a Linux gaming/dev machine. Queries are split
 * between lexical matches (FTS should carry them) and paraphrases (the
 * vector path should carry them). Keep entries semantically DISTINCT — the
 * eval asserts the corpus survives semantic dedup intact, which doubles as a
 * canary for an over-aggressive dedup threshold.
 */

export interface GoldenFact {
  key: string;
  body: string;
}

export interface GoldenArtifact {
  key: string;
  kind: 'playbook' | 'anti_pattern' | 'heuristic';
  title: string;
  body: string;
  tags: string[];
}

export interface GoldenQuery {
  query: string;
  /** Keys of facts/artifacts that should appear in the top results. */
  expected: string[];
  /** Why this query is in the set (lexical vs paraphrase vs distractor-prone). */
  note: string;
}

export const GOLDEN_FACTS: GoldenFact[] = [
  { key: 'browser', body: 'Default browser is Zen (Firefox fork); profile lives under ~/.zen' },
  { key: 'gpu', body: 'GPU is a Radeon RX 9070 XT on the open amdgpu driver' },
  { key: 'compositor', body: 'Desktop is KDE Plasma 6 on Wayland; X11 session is not installed' },
  { key: 'audio', body: 'Audio interface is a Focusrite Scarlett 2i2 via PipeWire' },
  { key: 'wifi-dock', body: 'The USB-C dock drops ethernet after suspend; replugging fixes it' },
  { key: 'game-launcher', body: 'Games run through Lutris with Wine-GE; Steam is flatpak' },
  { key: 'screenshot-tool', body: 'Spectacle is the screenshot tool; needs -bnfp flags for unattended capture' },
  { key: 'terminal', body: 'Preferred terminal is Konsole with the fish shell' },
  { key: 'editor', body: 'Code editor is VS Code installed as an RPM, not flatpak' },
  { key: 'monitor-layout', body: 'Two monitors: 2560x1440 primary left, 1920x1080 secondary right' },
  { key: 'package-manager', body: 'System is Fedora Kinoite; rpm-ostree for layering, prefers flatpak/toolbox' },
  { key: 'vpn', body: 'Work VPN is WireGuard, toggled with nmcli connection up wg0' },
  { key: 'backup', body: 'Backups run nightly via restic to a Hetzner storage box' },
  { key: 'mouse', body: 'Mouse is a Logitech G502; pointer acceleration is set to flat profile' },
  { key: 'night-light', body: 'Night Color is scheduled 21:00 to 07:00 at 4000K' },
  { key: 'printer', body: 'The Brother laser printer needs the ippeverywhere driver, not the Brother PPD' },
  { key: 'mic-noise', body: 'Microphone noise suppression uses the RNNoise PipeWire filter chain' },
  { key: 'kernel', body: 'Running the stock Fedora kernel; custom kernels broke secure boot before' },
  { key: 'ssh-keys', body: 'SSH keys live in ~/.ssh with ed25519; agent forwarding stays disabled' },
  { key: 'timezone', body: 'Machine timezone is America/New_York; user works late evenings' },
  { key: 'discord', body: 'Discord runs as a flatpak and screen sharing needs the portal permission reset occasionally' },
  { key: 'fan-curve', body: 'Case fan curve is managed by CoolerControl; config at ~/.config/coolercontrol' },
  { key: 'game-stutter', body: 'Elden Ring stutters when the shader cache is cold; second launch is smooth' },
  { key: 'clipboard', body: 'Klipper history is capped at 20 entries; images excluded for RAM reasons' },
];

export const GOLDEN_ARTIFACTS: GoldenArtifact[] = [
  {
    key: 'pb-audio-crackle',
    kind: 'playbook',
    title: 'Fix crackling audio under load',
    body: '1. Check PipeWire quantum: pw-metadata -n settings\n2. Raise min quantum to 1024\n3. Restart pipewire and wireplumber user services',
    tags: ['audio', 'pipewire'],
  },
  {
    key: 'pb-wine-prefix',
    kind: 'playbook',
    title: 'Repair a broken Wine prefix in Lutris',
    body: '1. Back up the prefix\n2. Run wineboot -u inside the Lutris runtime\n3. Reinstall vcredist via winetricks if DLL errors persist',
    tags: ['gaming', 'wine', 'lutris'],
  },
  {
    key: 'pb-flatpak-portal',
    kind: 'playbook',
    title: 'Reset flatpak portal permissions',
    body: 'flatpak permission-reset <app-id>; then relaunch the app so the portal prompt reappears',
    tags: ['flatpak', 'portal'],
  },
  {
    key: 'pb-ostree-rollback',
    kind: 'playbook',
    title: 'Roll back a bad rpm-ostree deployment',
    body: 'rpm-ostree rollback, reboot, then pin the working deployment with ostree admin pin 0',
    tags: ['fedora', 'rpm-ostree'],
  },
  {
    key: 'ap-kill-pipewire',
    kind: 'anti_pattern',
    title: 'Killing PipeWire to fix audio glitches',
    body: 'kill -9 on pipewire orphans wireplumber sessions and mutes all apps until logout. Restart the user service instead.',
    tags: ['audio', 'pipewire'],
  },
  {
    key: 'ap-xdotool-wayland',
    kind: 'anti_pattern',
    title: 'Using xdotool on the Wayland session',
    body: 'xdotool only reaches XWayland windows and silently no-ops on native Wayland surfaces. Use kdotool for window queries.',
    tags: ['wayland', 'automation'],
  },
  {
    key: 'heur-suspend-first',
    kind: 'heuristic',
    title: 'After suspend, suspect the dock first',
    body: 'When networking or USB devices misbehave right after wake, replug the USB-C dock before deeper debugging — it is the cause ~80% of the time on this machine.',
    tags: ['suspend', 'dock', 'hardware'],
  },
  {
    key: 'heur-shader-cache',
    kind: 'heuristic',
    title: 'First-launch stutter is usually shader compilation',
    body: 'A game stuttering on first launch after a driver or game update is almost always cold shader cache, not a config problem. Let it run a few minutes before changing settings.',
    tags: ['gaming', 'performance'],
  },
  {
    key: 'heur-flatpak-weird',
    kind: 'heuristic',
    title: 'Sandboxed app acting weird? Check portals before configs',
    body: 'When a flatpak app cannot see files, screens, or devices, check xdg-desktop-portal permissions before editing app configs.',
    tags: ['flatpak', 'portal', 'debugging'],
  },
];

export const GOLDEN_QUERIES: GoldenQuery[] = [
  { query: 'what browser does the user use', expected: ['browser'], note: 'paraphrase — body says "default browser is Zen"' },
  { query: 'graphics card model', expected: ['gpu'], note: 'paraphrase — no lexical overlap with "GPU is a Radeon"' },
  { query: 'spectacle flags screenshot', expected: ['screenshot-tool'], note: 'lexical' },
  { query: 'ethernet dead after waking from sleep', expected: ['wifi-dock', 'heur-suspend-first'], note: 'paraphrase — suspend/wake wording differs' },
  { query: 'sound crackles when gaming', expected: ['pb-audio-crackle'], note: 'paraphrase of crackling audio under load' },
  { query: 'how to fix a broken wine prefix', expected: ['pb-wine-prefix'], note: 'lexical' },
  { query: 'discord cannot share screen', expected: ['discord', 'pb-flatpak-portal'], note: 'cross: fact + playbook' },
  { query: 'undo a bad system update on kinoite', expected: ['pb-ostree-rollback'], note: 'paraphrase — rollback deployment' },
  { query: 'is it safe to kill pipewire', expected: ['ap-kill-pipewire'], note: 'anti-pattern lookup' },
  { query: 'xdotool not working', expected: ['ap-xdotool-wayland'], note: 'lexical + diagnosis' },
  { query: 'game runs badly the first time I start it', expected: ['game-stutter', 'heur-shader-cache'], note: 'paraphrase — stutter/shader cache' },
  { query: 'monitor resolution and arrangement', expected: ['monitor-layout'], note: 'paraphrase' },
  { query: 'how do backups work on this machine', expected: ['backup'], note: 'paraphrase — restic nightly' },
  { query: 'connect to the work vpn', expected: ['vpn'], note: 'lexical-ish — wireguard nmcli' },
];
