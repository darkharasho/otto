// The models Otto offers, newest of each family. The picker, the status
// footer label and the defaults all read from here so they can't drift apart.

export type ModelFamily = 'fable' | 'opus' | 'sonnet' | 'haiku';

export interface ModelOption {
  id: string;
  label: string;
  family: ModelFamily;
  tagline: string;
}

export const MODELS: ModelOption[] = [
  { id: 'claude-fable-5-1', label: 'Fable 5.1', family: 'fable', tagline: 'Most capable, slowest' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', family: 'opus', tagline: 'Highest reasoning' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', family: 'sonnet', tagline: 'Balanced — good default' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', family: 'haiku', tagline: 'Fastest, smallest' },
];

/** Model for new sessions when the user hasn't picked one. */
export const DEFAULT_MODEL = 'claude-sonnet-5-5';

/** Model for quick background jobs (reflection, summaries). */
export const BACKGROUND_MODEL = 'claude-haiku-5-5';

function familyOf(id: string): ModelFamily | null {
  for (const f of ['fable', 'opus', 'sonnet', 'haiku'] as const) {
    if (id.includes(f)) return f;
  }
  return null;
}

/**
 * The listed model for `id`: itself if listed, else the newest of its family
 * (so a saved pick like claude-opus-4-8 moves to Opus 5.5), else unchanged.
 */
export function currentModelId(id: string): string {
  if (MODELS.some((m) => m.id === id)) return id;
  const family = familyOf(id);
  return MODELS.find((m) => m.family === family)?.id ?? id;
}

/** Short label for a model id, e.g. "Opus 5.5". Falls back to the raw id. */
export function modelLabel(id: string): string {
  return MODELS.find((m) => m.id === id)?.label ?? id;
}
