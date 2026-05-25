# Otto iPhone Remote — Design

**Date:** 2026-05-24
**Status:** Spec, awaiting user review

## Context

Otto is currently a desktop-only Electron app — global hotkey, overlay window, local agent. The user wants to drive Otto from an iPhone while the desktop is running (e.g., monitor a long task from the couch, fire a "close the stuttering Chrome tab" prompt from another room, approve a destructive action away from the keyboard).

The desktop must be on for any of this to work — that is an accepted requirement, not a problem to solve.

## Goals

- Phone is a full second client to a shared Otto session: real-time streaming of assistant messages, tool calls, and screenshots.
- Either surface (desktop or phone) can resolve an autonomy-gated approval.
- Phone can never escalate autonomy above the desktop's current mode; an optional setting forces remote turns to `strict` regardless of desktop mode.
- Zero exposure to public internet or LAN. Bridge binds to the tailnet IP only.
- Pairing is one QR scan; revocable per-device from the desktop.
- v1 ships as a PWA so there is no App Store / sideload pipeline. Architecture preserves the option to wrap with Expo/React Native later.

### Non-Goals (v1)

- Native iOS app, push notifications, Face ID unlock.
- Working without Tailscale (no cloud relay, no port-forward fallback).
- Editing autonomy mode or denylist from the phone.
- Token rotation (revoke + re-pair is the rotation story).
- Multi-user / multi-account semantics. Single user, multiple devices.
- Load testing, formal security audit, fuzzing the wire protocol.

## Architecture

A new module `src/main/remote/` is added with three internal units:

- **`bridge-server.ts`** — owns the HTTP + WebSocket lifecycle. Resolves the tailnet IP at startup via `tailscale ip -4` and binds only to it. Serves the PWA static bundle at `/`, exposes `POST /pair` for pairing handshake, `GET /ws` for the event stream, `GET /screenshot/<id>?sig=…` for short-lived signed image fetches, and `GET /history?session_id=…&since=…` for reconnect backfill. Knows nothing about agents or sessions — pure transport between the wire and an in-process event bus.
- **`session-bus.ts`** — in-process pub/sub the agent loop and the bridge both attach to. Agent events fan out to every subscriber (desktop renderer + each connected phone). User-input messages (prompts, approvals) flow back through a single serialized queue per session, so two surfaces can never race a turn. Maintains a short ring buffer (last 200 events per session) for reconnect backfill.
- **`pairing-store.ts`** — wrapper around the existing SQLite DB (`src/main/db`) for paired-device records: `{ id, label, token_hash, paired_at, last_seen_at, revoked_at }`. Hashes use argon2id. Constant-time lookups via prepared statements.

On the renderer side, `src/renderer/remote/` holds the PWA: a React app built as a second Vite entry point in `electron.vite.config.ts`, sharing components with the existing overlay where it makes sense (message list, approval card, screenshot thumbnail).

Settings (`src/main/settings-window.ts`) gains a "Remote access" panel: enable/disable toggle, displayed tailnet URL, "Pair new device" button (shows QR), paired-device list with revoke buttons, and a "Force strict autonomy for remote turns" checkbox.

No new processes, no new daemons. The bridge is in the same process as the agent and subscribes to the same bus the desktop renderer already does.

## Wire Protocol

Single authenticated WebSocket carrying JSON frames. Every frame has `{ v: 1, type, ...payload }`.

### Client → server

- `auth` — first frame after connect: `{ type: "auth", token }`. Server validates against `pairing-store`. Replies `auth_ok` (with `device_label`, current `session_id`, current `autonomy_mode`) or closes with `auth_failed`.
- `prompt` — `{ type: "prompt", session_id, text, attachments? }`. Enqueued on the session's input queue.
- `approval` — `{ type: "approval", approval_id, decision: "approve"|"deny" }`. Resolves a pending tool-call gate.
- `interrupt` — `{ type: "interrupt", session_id }`. Cancels the in-flight turn (same code path as desktop stop button).
- `ping` — keepalive every 20s; server replies `pong`.

### Server → client

- `event` — wraps the existing internal agent-event shape (`assistant_message_delta`, `tool_call_started`, `tool_call_finished`, `screenshot_captured`, `turn_complete`, etc.). The same events the desktop renderer consumes.
- `approval_pending` — `{ approval_id, tool, summary, action_class, expires_at }`. Phone shows an approval card.
- `approval_resolved` — broadcast when any surface decides. Other surfaces dismiss their card.
- `session_state` — periodic snapshot (~5s while active) of `{ session_id, status, autonomy_mode, pending_approvals }` for reconnect resync.
- `error` — `{ code, message, fatal }`.

### Screenshots

Not inlined in events. The event carries a short-lived signed URL valid for 60s (`GET /screenshot/<id>?sig=…`). Phone lazy-loads thumbs and full-res on tap. Same bearer token authenticates the URL; signature is HMAC over `<id>|<exp>` with a per-bridge-startup secret.

### Reconnect

Phone reconnects → sends `auth` → server replies with current `session_state` → phone calls `GET /history?session_id=…&since=<last_seq>` to backfill. If the gap exceeds the ring buffer, response sets `truncated: true` and the PWA renders "Reconnected — earlier events not available, scroll desktop transcript for full history."

## Shared-Session Rules

The shared-session model forces three explicit rules:

**Rule 1 — Single serial input queue per session.** Desktop and phone push prompts/approvals through one queue. If you start typing on the desktop while the phone has an in-flight turn, your desktop prompt lands in the queue and runs next; it does not interleave. Both UIs show a "queued" indicator.

**Rule 2 — Approvals are first-resolver-wins, broadcast immediately.** `session-bus` emits `approval_pending` with an `approval_id` to every connected surface. First `approval` frame wins; bus broadcasts `approval_resolved`, other surfaces dismiss with a small "(approved on desktop)" / "(approved on iPhone)" annotation. Late resolution on a stale approval returns a no-op ack, never an error.

**Rule 3 — Remote turns clamp autonomy, never escalate.** Autonomy mode stays a desktop-owned setting. A phone-initiated turn runs at the *more restrictive* of the desktop mode and the configured `remote_ceiling`, where the ordering from most-restrictive to least is `strict < balanced < full-allow`. `remote_ceiling` is:

- `match` (default) — no extra clamp; phone uses the desktop's current mode.
- `strict` — phone turns always require approval for anything reversible-or-worse, regardless of desktop setting (the "Force strict autonomy for remote turns" checkbox).

The phone can display the effective mode but cannot change it. Same for the denylist — phone has no edit surface.

The phone's approval card prominently displays the tool's action class (`read` / `reversible` / `destructive` / `irreversible`), since the user is physically away from the screen.

**Idle disconnect.** WS with no ping for 60s is dropped server-side. Pending approvals owned by the dropped client are not auto-resolved — they sit in the queue waiting for the desktop or a reconnected phone.

## Pairing Flow

The only time secrets cross devices.

### Desktop side (Settings → Remote access → "Pair new device")

1. Bridge generates a one-time pairing code: 32 random bytes, base64url. Stored in-memory `{ code, created_at, expires_at: +120s }`. Never persisted.
2. Settings window renders a QR encoding `otto-pair://<tailnet-ip>:<port>?code=<pairing-code>` plus the URL as copyable text.
3. Pairing code is single-use and expires after 120s whether claimed or not.

### Phone side

1. User scans QR with iOS camera; Safari opens the URL. (For the install case, the PWA also has a "Pair this device" screen where the URL can be pasted — handles the chicken-and-egg of "PWA not yet installed so deep link has nowhere to go.")
2. PWA `POST /pair` with `{ code, device_label }`. `device_label` defaults to `iPhone (Safari)` from User-Agent but is editable.
3. Bridge validates code (exists + not expired + not consumed). Generates bearer token (32 random bytes, base64url), hashes with argon2id, stores `{ id, label, token_hash, paired_at, last_seen_at: null, revoked_at: null }` via `pairing-store`.
4. Response: `{ token, device_id, ws_url }`. PWA stores `token` in `localStorage` (acceptable: single-origin on tailnet IP, no third-party JS).
5. Bridge consumes the pairing code (deleted from in-memory map).

### On every subsequent connect

PWA opens WS, sends `auth` with token. Bridge hashes and looks up. On match, updates `last_seen_at`. On miss or revoked, closes with `auth_failed`.

### Revocation

Settings shows paired-device list with `label`, `paired_at`, `last_seen_at`, and Revoke button. Revoke sets `revoked_at` and force-closes any active WS for that device. No grace period.

### Why tokens are hashed

If the SQLite DB is read (backup, stolen unlocked laptop) we don't want live tokens harvested. Hash cost is paid once per WS connect, not per message.

## Failure Modes

- **Tailscale not running at startup.** Bridge logs and stays down. No fallback to `0.0.0.0` or `127.0.0.1` — this is the single most important invariant. Settings panel shows "Tailscale not detected — install/start Tailscale and toggle Remote access off/on."
- **Tailnet IP changes.** Bridge polls `tailscale ip -4` every 60s; on change, rebinds and emits `session_state` carrying the new URL. Existing paired tokens stay valid — only the URL changes; the user may need to re-add the home-screen shortcut.
- **Bridge crash inside Otto's process.** Bridge runs inside a small supervisor catching synchronous throws and unhandled rejections from its own code path. One restart attempt; if restart fails twice in 60s the bridge stays down and the rest of Otto keeps running. The agent loop is never in the bridge's crash blast radius because they only communicate via `session-bus` events.
- **WS disconnect mid-turn.** Agent doesn't care. Events accumulate in the ring buffer. Reconnect → backfill via `/history`. Gap larger than ring buffer → `truncated: true`.
- **Approval expires while phone offline.** Gate stays open. On reconnect, `session_state` rehydrates the pending list. If the desktop resolved it, phone receives `approval_resolved`.
- **Token leaked.** Revoke from desktop → WS force-closed → next request fails auth. Threat model is "physical / tailnet access," not "internet attacker."
- **Concurrent prompts.** Already handled by Rule 1 (serialized queue). Documented here so it isn't surprising.
- **Screenshot URL leaked.** Expires 60s, single-use server-side. After expiry the screenshot is only reachable via authenticated WS.

## Testing

### Unit (vitest, `src/main/remote/*.test.ts`)

- `pairing-store` — token hash/verify round-trip; expired-code rejection; single-use enforcement; revocation closes lookups.
- `session-bus` — single-queue serialization (two simultaneous prompts produce deterministic order); approval first-resolver-wins broadcast; ring-buffer truncation behavior; no event leakage across sessions.
- `bridge-server` — `auth` frame required as first message (anything else closes the WS); tailnet-only bind refuses `0.0.0.0`; signed screenshot URL expiry + single-use; rate-limit on `/pair` (10/min) to make pairing-code brute force uninteresting.

### Integration (vitest, in-process bridge + fake agent)

- Full pair → connect → prompt → event-stream → approval round-trip.
- Disconnect mid-turn → reconnect → backfill via `/history` → final state matches desktop view.
- Desktop-initiated turn observed by phone client receives the same event stream as the desktop renderer.
- Autonomy clamping: phone-initiated turn with `remote_ceiling: strict` while desktop is in `full-allow` correctly forces approvals on reversible actions.

### E2E (playwright, `tests/remote/`)

- PWA load → paste pairing URL → submit → land on chat screen showing current `session_state`.
- Issue prompt → assistant streaming appears → approval card appears → tap approve → tool runs → result rendered.
- Two browser contexts (desktop overlay + phone PWA) on same session — approval resolved in one dismisses in the other within 1s.
- Tailscale-down case: stub `tailscale ip -4` to fail → bridge stays down → settings panel shows the expected warning.

### Manual smoke (one-time, real hardware before each release)

- Real iPhone Safari → tailnet URL → "Add to Home Screen" → kill PWA → reopen → confirm token persisted and session resumes.
- Cellular only (Wi-Fi off on phone) with desktop on home Wi-Fi — confirm tailnet routing works without LAN access.

## Open Questions

None at spec time. Items deliberately deferred:

- Native iOS wrapper (after PWA v1 ships and the protocol stabilizes).
- "Jump in" UI to attach phone to an existing desktop conversation list (current model: phone joins the single active shared session).
- Token rotation without re-pair.
- Push notifications for `approval_pending` when PWA is backgrounded — PWAs on iOS have limited support here; revisit when iOS PWA notification story improves or when we move to native.
