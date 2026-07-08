export const IDLE_GATE_MS = 5 * 60 * 1000;
export const SIMILARITY_THRESHOLD = 0.35;
export const CONTEXT_WINDOW_CHARS = 2000;
// Must cover the embedding pass plus one LLM confirmer round-trip.
export const TOPIC_SHIFT_EVALUATE_TIMEOUT_MS = 8000;
// Below this the prompt is an ack ("A", "yes", "do it") whose embedding is
// noise — measured on real sessions it can score near 0 against any context.
export const MIN_PROMPT_WORDS = 4;
export const TOPIC_SHIFT_CONFIRM_TIMEOUT_MS = 6000;
