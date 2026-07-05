export interface VoiceCatalogEntry {
  id: string;
  label: string;
  /** One-liner shown under the label, e.g. "warm American female" */
  descriptor: string;
}

/**
 * Curated subset of the installed kokoro-js voice set.
 * IDs verified against node_modules/kokoro-js/voices/*.bin (July 2026).
 * Only include voices with .bin files present in the package.
 */
export const VOICE_CATALOG: VoiceCatalogEntry[] = [
  { id: 'af_heart',    label: 'Heart',    descriptor: 'Warm American female — default' },
  { id: 'af_bella',    label: 'Bella',    descriptor: 'Bright American female' },
  { id: 'af_nicole',   label: 'Nicole',   descriptor: 'Breathy American female' },
  { id: 'af_sky',      label: 'Sky',      descriptor: 'Light American female' },
  { id: 'am_adam',     label: 'Adam',     descriptor: 'Deep American male' },
  { id: 'am_michael',  label: 'Michael',  descriptor: 'Mature American male' },
  { id: 'bf_emma',     label: 'Emma',     descriptor: 'Warm British female' },
  { id: 'bf_isabella', label: 'Isabella', descriptor: 'Refined British female' },
  { id: 'bm_george',   label: 'George',   descriptor: 'Measured British male' },
  { id: 'bm_lewis',    label: 'Lewis',    descriptor: 'Crisp British male' },
];

export const DEFAULT_TTS_VOICE = 'af_heart';
export const DEFAULT_TTS_SPEED = 1.05;
