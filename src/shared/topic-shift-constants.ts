export const IDLE_GATE_MS = 5 * 60 * 1000;
export const SIMILARITY_THRESHOLD = 0.35;
export const CONTEXT_WINDOW_CHARS = 2000;
// Must cover the embedding pass plus one LLM confirmer round-trip.
export const TOPIC_SHIFT_EVALUATE_TIMEOUT_MS = 8000;
// Below this the prompt is an ack ("A", "yes", "do it") whose embedding is
// noise — measured on real sessions it can score near 0 against any context.
export const MIN_PROMPT_WORDS = 4;
export const TOPIC_SHIFT_CONFIRM_TIMEOUT_MS = 6000;

/**
 * User-facing dial for how aggressively Otto suggests starting a new
 * conversation. `off` disables detection entirely; `medium` reproduces the
 * legacy behavior. Default is `low` — cosine similarity cannot cleanly separate
 * topic shifts from follow-ups on real data (the distributions overlap), so the
 * calm end of the dial leans on a longer idle gate and a conservative LLM
 * confirmer rather than the embedding threshold.
 */
export type TopicShiftSensitivity = 'off' | 'low' | 'medium' | 'high';

export const TOPIC_SHIFT_SENSITIVITIES: TopicShiftSensitivity[] = [
  'off',
  'low',
  'medium',
  'high',
];

export interface TopicShiftParams {
  /** When false, the renderer skips the detector entirely. */
  enabled: boolean;
  /** Minimum idle time before a submit is eligible for detection. */
  idleGateMs: number;
  /** Flag a potential shift when cosine similarity is strictly below this. */
  similarityThreshold: number;
  /** Prompts shorter than this (in words) bypass detection as noise. */
  minPromptWords: number;
  /** Bias the LLM confirmer to only fire on clearly-unrelated messages. */
  confirmerConservative: boolean;
}

export function paramsForSensitivity(level: TopicShiftSensitivity): TopicShiftParams {
  switch (level) {
    case 'off':
      return {
        enabled: false,
        idleGateMs: Infinity,
        similarityThreshold: 0,
        minPromptWords: Infinity,
        confirmerConservative: false,
      };
    case 'low':
      return {
        enabled: true,
        idleGateMs: 15 * 60 * 1000,
        similarityThreshold: 0.28,
        minPromptWords: 6,
        confirmerConservative: true,
      };
    case 'medium':
      return {
        enabled: true,
        idleGateMs: IDLE_GATE_MS,
        similarityThreshold: SIMILARITY_THRESHOLD,
        minPromptWords: MIN_PROMPT_WORDS,
        confirmerConservative: false,
      };
    case 'high':
      return {
        enabled: true,
        idleGateMs: 2 * 60 * 1000,
        similarityThreshold: 0.45,
        minPromptWords: 3,
        confirmerConservative: false,
      };
  }
}
