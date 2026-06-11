# Memory Follow-ups: Image Budget, Recall Eval Harness, Provenance UI

**Date:** 2026-06-11
**Status:** Approved ("do it" — the three follow-ups from the memory polish round)

## 1. Screenshot image budget → conversation rollover

The SDK child process must hold the full API conversation history — every
screenshot's base64 JPEG — to resend each turn. The installed SDK (0.1.77) exposes no
context-editing control, only auto-compaction at the context limit. The lever Otto
controls is *when a conversation rolls over*, and precedent exists: idle-timeout
(`ConversationPolicy`) and topic-shift both start fresh sessions at submit time.

- New `src/main/agent/image-budget.ts`: per-session counter of images sent to the
  API. `noteImagesSent(sessionId, n)`, `imagesSent`, `overBudget` (threshold
  `IMAGE_BUDGET = 60`), `clearImageBudget(sessionId)`.
- `sdk-client.ts` counts each screenshot's tiles and each verification crop against
  the active session.
- `session.ensureForSubmit` (`ipc/handlers.ts`): if the current session is over
  budget, start a fresh session with new reason `'image-budget'`
  (`SessionEnsureForSubmitResult.reason` union extended). Counter cleared for the
  old session there and on `session.close`.

Cost framing: 60 images ≈ 60 × ~100-200KB JPEG resent on EVERY subsequent turn —
the budget caps SDK memory growth and the quadratic token/latency cost together.

## 2. Offline recall-quality eval harness

- `src/main/memory/eval/golden.ts`: hand-built corpus (~24 facts, ~9 artifacts
  realistic for Otto's domain) plus ~14 queries with expected hits — half lexical,
  half paraphrase (exercising the vector path).
- `src/main/memory/eval/recall-eval.ts`: seeds a temp DB through the real
  `FactRepo`/`ArtifactRepo`/`MemorySearch` stack with a provided embedder; runs all
  queries; returns `{ recallAt5, mrr, misses, corpusIntact }`. `corpusIntact`
  doubles as a dedup-threshold canary: if semantic dedup collapses distinct golden
  memories at write time, the corpus count won't match.
- `src/main/memory/eval/recall-eval.test.ts`: skipped unless `OTTO_MEMORY_EVAL=1`.
  Loads the real MiniLM model directly from `resources/embedding` (bypassing the
  Electron-dependent `getEmbedder`). Asserts corpus integrity, recall@5 ≥ 0.8,
  MRR ≥ 0.6.
- npm script `eval:memory` runs it.

## 3. Provenance in the settings memory UI

- `MemoryFactView` gains `createdAt`, `distinctSessions`, `archived`;
  `memory.list` fact mapping fills them.
- `MemorySection.tsx`: facts show a provenance line (learned date, last used,
  sessions seen, use count) and an `archived` badge; artifacts show updated/last
  used dates alongside the existing use count.

## Testing

image-budget: pure unit tests + an ensureForSubmit-level test if the harness
permits. Eval harness is itself a test (env-gated). UI: extend
`MemorySection.test.tsx` for the provenance line. Full suite must stay green.
