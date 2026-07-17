# Topic-shift sensitivity setting + popup keyboard controls

**Date:** 2026-07-17
**Status:** Approved

## Problem

Two complaints about the "new conversation" (topic-shift) popup:

1. **Too sensitive.** The popup fires far too often on messages that are really
   follow-ups within the current task.
2. **No keyboard controls.** Only `Escape` (= keep going) is wired. The user
   wants to accept *or* dismiss the popup from the keyboard.

### Background

The detector (`src/main/agent/topic-shift-detector.ts`) is a 3-stage pipeline:
embedding cosine pre-filter (`sim < 0.35`) → min-word gate (`>= 4` words) →
LLM confirmer. A prior investigation established that **cosine similarity cannot
separate topic shifts from follow-ups on real data** (the distributions overlap
fully), so the cosine threshold only controls *how many candidates reach the
LLM*; the **LLM confirmer is the real decision**. The renderer also gates on a
5-minute idle window before consulting the detector at all.

## Design

### Part 1 — `topicShiftSensitivity` setting (`off / low / medium / high`)

A new persisted setting, **default `low`** (today's behavior is effectively
"medium", so upgrading users get calmer detection immediately).

Level → parameter bundle, defined once in `src/shared/topic-shift-constants.ts`
as `paramsForSensitivity(level)` so the renderer gate and the main-process
detector stay in sync:

| Level  | enabled | idleGateMs | similarityThreshold (`flag if sim <`) | minPromptWords | confirmerConservative |
|--------|---------|-----------:|--------------------------------------:|---------------:|-----------------------|
| off    | false   | —          | —                                     | —              | —                     |
| low    | true    | 15 min     | 0.28                                  | 6              | true                  |
| medium | true    | 5 min      | 0.35                                  | 4              | false                 |
| high   | true    | 2 min      | 0.45                                  | 3              | false                 |

- **off** short-circuits in the renderer — no IPC, no embedding, no LLM call.
- **confirmerConservative** (low only) appends a stricter instruction to the
  confirmer prompt: only answer `newTopic=true` when the newest message is
  *clearly unrelated* to the current task; when unsure, answer `false`. The
  confirmer already fails safe (returns `false`) on timeout/parse errors. This
  bias is what actually reduces over-firing.
- Lowering the threshold at `low` (0.28) also reduces how many candidates reach
  the LLM.

### Part 2 — Popup keyboard controls (`TopicShiftChip`)

- Focus starts on **"Keep going"** (the safe default).
- **← / →** move focus between the two buttons.
- **Enter / Space** activate the focused button (native button behavior).
- **Cmd/Ctrl+Enter** always starts a new conversation, regardless of focus.
- **Esc** = keep going.

The chip manages focus with refs + an `onKeyDown` on its container and
autofocuses the "Keep going" button on mount. To avoid clashing with Otto's
global key handlers (Esc collapses the window; arrows resize it), `App.tsx`
gains one guard: the global **Escape** handler early-returns while
`pendingTopicShift` is set. (Arrow Up/Down handlers already early-return when
focus is off the text input, so focusing a chip button neutralizes them; the
chip uses ←/→ which App does not bind except under Ctrl+Shift.)

## Files touched

- `src/shared/topic-shift-constants.ts` — `TopicShiftSensitivity` type +
  `paramsForSensitivity()`. Keep existing exported constants (still referenced
  by tests / medium defaults).
- `src/main/autonomy/settings.ts` — new field default `low`, getter/setter,
  version bump 6→7 + migration.
- `src/shared/ipc-contract.ts` — add to `SettingsView`, new
  `settings.setTopicShiftSensitivity` channel.
- `src/main/ipc/handlers.ts` — handler for the new channel.
- `src/main/agent/topic-shift-detector.ts` — `getSensitivity` dep; apply
  threshold / minWords / conservative confirmer bias.
- `src/main/index.ts` — wire `getSensitivity: () => settings.getTopicShiftSensitivity()`.
- `src/renderer/App.tsx` — fetch sensitivity; use its `idleGateMs`; skip
  evaluate when `off`; guard the global Escape handler while a shift is pending.
- `src/renderer/components/settings/TopicShiftSection.tsx` (new) + register in
  `SettingsNav.ts` and `SettingsApp.tsx` under Behavior.
- `src/renderer/components/TopicShiftChip.tsx` — keyboard model above.

## Testing

- `topic-shift-constants.test.ts` — `paramsForSensitivity` returns the right
  bundle per level; `off` is disabled.
- `topic-shift-detector.test.ts` — threshold/minWords honor the injected
  sensitivity; conservative bias appears in the confirmer prompt at `low`.
- `settings.test.ts` — v6→v7 migration defaults `topicShiftSensitivity` to
  `low`; setter validates.
- `TopicShiftChip.test.tsx` — default focus on Keep going; ←/→ move focus;
  Enter activates focused; Cmd/Ctrl+Enter starts new; Esc keeps going.

## Out of scope

- No change to the separate `newConversation.idleTimeoutMinutes` auto-rollover
  setting.
- No re-architecture of the detector pipeline.
