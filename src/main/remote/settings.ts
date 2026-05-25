import fs from 'node:fs';
import path from 'node:path';
import type { RemoteCeiling } from '../autonomy/policy';

export interface RemoteSettings {
  enabled: boolean;
  remoteCeiling: RemoteCeiling;
}

export function defaultRemoteSettings(): RemoteSettings {
  return { enabled: false, remoteCeiling: 'match' };
}

export function loadRemoteSettings(file: string): RemoteSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...defaultRemoteSettings(), ...raw };
  } catch {
    return defaultRemoteSettings();
  }
}

export function saveRemoteSettings(file: string, s: RemoteSettings): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s, null, 2));
}
