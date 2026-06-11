# Proactive Idle Reset — Fresh-Session UI Before the Next Message

**Date:** 2026-06-11
**Status:** Approved

## Problem

The new-conversation idle timeout (`ConversationPolicy.shouldStartFresh()`) is only
consulted inside `session.ensureForSubmit` — at submit time. Summoning Otto after
hours away shows the stale conversation until a message is actually sent, then the
view abruptly swaps to a new session.

## Design

- **`session.peekFresh` IPC** (read-only): returns
  `{ fresh: conversationPolicy.shouldStartFresh() }`. Deliberately does NOT record
  activity — peeking must not keep a conversation alive — and creates nothing.
- **Renderer** (`App.tsx`): on app mount and every `visibilitychange` to visible
  (the summon path — hotkey, tray, toggle socket), call `peekFresh`; when true,
  call the existing `abandonActiveSession()` so the fresh-start UI shows before any
  message. The session id is re-checked after the IPC round-trip so a turn that
  started meanwhile can't be yanked.
- **Guards** (`canProactivelyReset` in `state/store.ts`, unit-tested): never reset
  a busy session (running turn or queued messages), never an already-empty view,
  and never a private session — private sessions aren't in the history list, so
  abandoning one without a user action would destroy it. Normal sessions stay
  reachable from history after the reset.
- `ensureForSubmit` is unchanged and remains the authoritative rollover: after a
  proactive reset, submit takes the existing `no-session` path.

## Out of scope

Rolling the view over in place while the window stays visible (would yank a
conversation the user may be reading); notifying the user why the view reset.
