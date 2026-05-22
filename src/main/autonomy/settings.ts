import fs from 'node:fs/promises';
import path from 'node:path';
import type { AutonomyMode } from '@shared/messages';

const CURRENT_VERSION = 1;
const DEFAULT_MODE: AutonomyMode = 'balanced';
const VALID_MODES: AutonomyMode[] = ['strict', 'balanced', 'full-allow'];

interface SettingsFile {
  version: number;
  autonomy: { mode: AutonomyMode };
}

type Listener = (mode: AutonomyMode) => void;

export class Settings {
  private mode: AutonomyMode = DEFAULT_MODE;
  private listeners = new Set<Listener>();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    let parsed: unknown = null;
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      parsed = JSON.parse(raw);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        await this.writeDefaults();
        return;
      }
      console.warn(`[settings] could not read ${this.filePath}, using defaults:`, err);
      await this.writeDefaults();
      return;
    }

    const ok = this.applyParsed(parsed);
    if (!ok) {
      console.warn(`[settings] ${this.filePath} is malformed or has unknown version; using defaults`);
      await this.writeDefaults();
    }
  }

  getMode(): AutonomyMode {
    return this.mode;
  }

  async setMode(mode: AutonomyMode): Promise<void> {
    if (!VALID_MODES.includes(mode)) throw new Error(`invalid mode: ${mode}`);
    this.mode = mode;
    await this.writeFile();
    for (const fn of this.listeners) fn(mode);
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private applyParsed(parsed: unknown): boolean {
    if (!parsed || typeof parsed !== 'object') return false;
    const obj = parsed as Partial<SettingsFile>;
    if (obj.version !== CURRENT_VERSION) return false;
    const m = obj.autonomy?.mode;
    if (!m || !VALID_MODES.includes(m)) return false;
    this.mode = m;
    return true;
  }

  private async writeDefaults(): Promise<void> {
    this.mode = DEFAULT_MODE;
    await this.writeFile();
  }

  private async writeFile(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    const payload: SettingsFile = { version: CURRENT_VERSION, autonomy: { mode: this.mode } };
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2));
    await fs.rename(tmp, this.filePath);
  }
}
