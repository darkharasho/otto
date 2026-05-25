# Mobile Remote — Learnings for Cross-Project Reuse

Notes from building Otto's iPhone/Mobile remote feature (Tailscale-private PWA → Electron host). Written for porting the same shape to SAI.

## Core architecture (TL;DR)

```
phone (any browser)
   ↓ PWA bundled with the Electron app
   ↓ WebSocket + HTTP, both over Tailscale (private mesh, no public exposure)
desktop Electron main process
   ├─ BridgeServer (http + ws on tailnet IP)
   ├─ SessionBus (fan-out + ring buffer)
   ├─ PairingStore (argon2id hashed bearer tokens, SQLite)
   ├─ RemoteModule (supervisor: tailnet polling, crash retry)
   └─ existing agent loop (unchanged) — just adds the bus as a second subscriber
```

The PWA is a second renderer entry served by the same Electron bundle. Bridge binds **only** to the tailnet IP (refuses to start otherwise — there is no LAN/public fallback).

## Decisions that paid off

### 1. PWA over native app
- iOS "Add to Home Screen" makes the PWA feel native.
- Zero App Store / TestFlight / sideload pipeline.
- Same React/Vite/Tailwind stack as the desktop renderer — components share where they make sense.
- Trade-off: no push notifications on iOS PWAs, no real background behavior. Acceptable if the desktop is the source of truth.

### 2. Tailscale-only network
- Devices already authenticate via the tailnet — auth is "device on tailnet" + an app-level token.
- No public ports, no relay server to host.
- MagicDNS gives nice hostnames (`http://otto.<tailnet>.ts.net:PORT/`) for free — works from cellular too.
- Trade-off: user must install Tailscale on the phone (one-time setup).

### 3. QR pairing with hashed bearer tokens
- The pair QR encodes `http://<host>:<port>/?code=<32-byte-base64url>` — iOS Camera opens Safari, the PWA reads `?code` from the URL, auto-pairs.
- Pairing code is single-use, in-memory only, 120s TTL.
- Bearer token is argon2id-hashed in SQLite. Verify costs ~50–100ms but happens once per WS connect.
- Revocation is per-device (flip `revoked_at`).
- Critical: **don't** use a custom URL scheme (`otto-pair://...`) — iOS won't open it in Safari, and the PWA can't access the camera to scan QRs. Stick with `http://`.

### 4. Stable port for the bridge
- Port `0` (OS-assigned) breaks home-screen icons on restart (new port = new origin = lost `localStorage`).
- Pick a fixed unreserved port (we used `17829`), fall back to ephemeral only on `EADDRINUSE`.
- Keep the default `0` inside the class (avoids vitest worker contention in CI). The single production call site pins the stable port.

### 5. Fan-out event bus (with one important gotcha)
- The agent's existing `emit(SessionEvent)` callback is preserved; just wrap it so events also go to a `SessionBus`.
- The bus has per-session subscribers AND an "all sessions" subscriber (`subscribeAll`).
- **Bug we hit:** initially the bridge subscribed to `activeSessionId()` at WS-auth time. If no session existed yet (common when the phone connects first), the subscription was to `null` and silently dropped everything later. **Fix:** always `subscribeAll`, include the sessionId in each forwarded frame, let the client filter or attach as needed.

### 6. Input routing: direct callback, not via the bus
- We originally tried to route inbound prompts through the bus's per-session input queue. The handler was only registered when the user typed on the desktop (via `onUserActiveListener`), so phone-only flows had no handler → prompts silently dropped.
- **Fix:** bypass the bus for inbound. The bridge gets `sendPrompt(text, origin)`, `interruptTurn(sid?)`, `resolveApproval(decisionId, choice)` callbacks. The bus is the *output* channel; input is direct callbacks.
- The bus's serialized-input queue is over-engineering for a single-user app where there's typically one active session. `SessionManager` itself serializes turns via the abort controller.

### 7. Autonomy clamping
- Remote-originated turns can be clamped to a stricter mode than the desktop (e.g., "force strict for remote regardless of desktop setting").
- Mode ordering: `strict < balanced < full-allow`. `clamp(desktopMode, ceiling)` returns the more-restrictive.
- Implementation: optional `origin` field on `DecideArgs`, a `remoteCeiling` getter on the broker. When `origin === 'remote'`, evaluate with the clamped mode.
- Threading `origin` from `SessionManager.send` → `sdk-client` → `broker.decide` is the deferred piece; it works at the broker level but isn't wired end-to-end yet.

### 8. Signed, single-use screenshot URLs
- Don't inline image bytes in WS frames. Each event carries `signedUrl` (HMAC over `id|exp|nonce`, 60s TTL, single-use server-side).
- **Subtle bug:** without a nonce, two URLs signed for the same id at the same instant are identical → single-use semantics collapse. Always include a random nonce in the payload.
- On the client, fetch into a blob URL and reuse for both thumb + modal (server-side single-use is satisfied with one fetch).

### 9. Hybrid renderer pattern
- The PWA lives at `src/renderer-remote/` with its own Vite entry.
- electron-vite v2 doesn't reliably support array-form `renderer` config — fall back to a standalone `vite.config.pwa.ts` invoked from the main `build` script. Simpler than fighting the config shape.
- Tailwind config: extend `content` to include the new directory.
- TypeScript: include the new directory in `tsconfig.json`.
- The bridge serves the built bundle from `out/renderer-remote/` with SPA fallback (unknown paths → `index.html`) so deep links work after "Add to Home Screen."

### 10. RemoteModule supervisor
- One small orchestrator: resolves tailnet IP, constructs BridgeServer, polls for IP changes every 60s, rebinds on change.
- One-shot crash retry: if `bridge.start()` throws, retry once after 1s. If it fails again, stay down with a clear `reason` string in `status()`.
- Settings panel shows `running` + `url` + `reason` for transparency.

## Critical bugs and root causes

| Symptom | Root cause | Fix |
|---|---|---|
| Phone connects, sends prompts, agent responds, but PWA shows nothing | Bridge subscribed to `activeSessionId()` at WS-auth time; that returned null on first connect, subscription was to a dead key | `subscribeAll` + include `sessionId` in every WS frame |
| Phone-sent user message doesn't appear on desktop | Desktop renderer's `applyEvent` filters by `session.id`; phone-created session never became `activeSession` on desktop | Auto-attach to unknown sessionIds via existing `session.load` IPC + buffer events until attach completes |
| Phone-sent user message doesn't appear in either UI | `SessionManager.send` only persisted the user message, never emitted an event | Add `user-message` SessionEvent variant + emit after `appendMessage`; both renderers handle it (with dedup vs desktop's optimistic add) |
| First phone-initiated prompt hangs the PWA indefinitely | `sessions.start({})` could throw silently; the bridge fired the prompt callback fire-and-forget | Wrap callback in try/catch, publish synthetic `done` + `error` frames on failure, add 30s client-side watchdog |
| Bar shows but never expands when phone starts a turn | `attachSession` set `activeSession` but never flipped `windowMode` | Set windowMode to 'panel' + IPC `window.setMode` inside `attachSession` |
| Home-screen icon dies after restart | Bridge listened on port 0; new random port = new origin = lost localStorage | Stable default port at the production call site; ephemeral default inside the class |
| Tool cards stuck at the bottom of the transcript | After tool-call-start, text-deltas appended to the same `currentTextIdRef` text bubble (the one before the tool) | Clear `currentTextIdRef` on tool-call-start so next deltas create a fresh bubble below the tool card |
| Lint failure in CI but not locally | An `eslint-disable-next-line jsx-a11y/alt-text` comment referenced a plugin that wasn't installed | Remove the disable comment (or install the plugin) |
| `/pair` rate-limit test failed in CI only | vitest workers contended for the default port 17829, EADDRINUSE fallback raced socket-reuse | Default to ephemeral inside the class; pin stable port only at the production call site |

## UX patterns worth copying

- **Bubble-less typing state.** While streaming has started but no text has arrived, render just the 3-dot animation without the assistant chrome. Feels lighter, especially on small screens.
- **Collapsible tool cards.** Defaults to collapsed (just name + status). Tap to expand input/result JSON. Critical for tools that produce long output.
- **Session drawer.** Hamburger top-left opens a left drawer with "+ New chat" and a recent-sessions list. Tap a session → backfill its history into the transcript.
- **Markdown rendering everywhere.** If your tailwind config doesn't include `@tailwindcss/typography`, define a small `MD_COMPONENTS` map with explicit utility classes for `p/h1-4/ul/ol/li/a/code/pre/blockquote/hr/table`. Tiny effort, much better readability.
- **Hide the optimistic input echo race.** Optimistic UI on desktop is fine, but the same code path must dedupe when the real user-message event arrives.

## Testing strategy

- **Most coverage at the unit/integration level.** PairingStore, SessionBus, BridgeServer routes, screenshot URL signer, autonomy clamp — all vitest with stub deps.
- **One Node-level E2E** (`end-to-end.test.ts`) that exercises pair → auth → live event → prompt → approval → reconnect using the actual `ws` library and `fetch`. No browser needed. Caught a real composition bug at the HTTP+WS server level.
- **Skip a full browser E2E** unless you specifically need to catch CSS/SW/install-flow regressions. Use a manual smoke checklist on real hardware for those.
- **Manual smoke checklist** (one markdown file): network isolation, cellular-only, pairing, revoke, reconnect, autonomy clamp, etc. Walk it before each release.

## SAI-specific considerations to think about

(I don't know SAI's exact shape — adapt these.)

1. **What's the "active session" concept?** Otto's session = one Claude conversation. The bridge needed to know which one to forward events for. If SAI has multiple concurrent things (agents, jobs, tools), the wire protocol needs an explicit `subscribe { topic: ... }` rather than implicit "active session".
2. **Where does the agent loop emit events?** Otto had a clean `emit(SessionEvent)` callback we could fan out. If SAI uses a different pattern (queues, pubsub, EventEmitter), wrap it; don't refactor the agent.
3. **Auth model.** Tailscale + bearer token works because SAI users are likely individuals or small teams. For multi-tenant, you need real identity (OIDC, SSO, signed device JWTs).
4. **Tool gating.** If SAI has approval gates, mirror the first-resolver-wins broadcast pattern. The desktop's `DecisionBroker.resolve(id, choice)` was already idempotent which made this trivial.
5. **Screenshot/large-binary delivery.** Signed URLs > inlining. Always nonce the signature.
6. **Do you need cross-device session sharing or independent sessions per device?** Cross-device (Otto's model) is more ambitious but feels like one consistent Otto. Independent sessions are simpler. Decide before building.

## What I'd do differently if starting over

1. **Skip the per-session input queue.** We built it for the "two surfaces, one queue" invariant (Spec Rule 1) but never actually used it for input — direct callbacks won. Save the engineering.
2. **Emit `user-message` events from day one.** We added this late after discovering both renderers relied on optimistic UI for user bubbles. It's a fundamental event, not an afterthought.
3. **Auto-attach the desktop to any unknown sessionId in `applyEvent` from the start.** This is the natural behavior for "same app, multiple surfaces" — don't make the desktop renderer assume it owns session creation.
4. **Use `http://` URLs for QR pairing from day one.** The custom `otto-pair://` scheme was a dead end because iOS Camera can't open custom schemes and the PWA can't access the camera.
5. **Pin a stable port from day one** (and make the class default ephemeral so tests don't contend). Saves the "icon dies after restart" rediscovery.
6. **Wire `origin` through to the autonomy broker end-to-end immediately.** We left this as a deferred piece (broker accepts it, but `SessionManager.send` doesn't pass it through `sdk-client` to `broker.decide` yet). The clamp works at the broker level but the full path isn't connected.

## Specific files worth reading in Otto

If porting, read in this order:

1. `docs/superpowers/specs/2026-05-24-iphone-remote-design.md` — the design spec (what we set out to build).
2. `docs/superpowers/plans/2026-05-24-iphone-remote.md` — the 31-task plan (how we built it, step by step).
3. `src/main/remote/bridge-server.ts` — HTTP + WS server, the wire protocol concrete shape.
4. `src/main/remote/session-bus.ts` — fan-out bus, especially `subscribeAll`.
5. `src/main/remote/pairing-store.ts` — argon2 hashed tokens.
6. `src/main/remote/screenshot-urls.ts` — HMAC signer with nonce.
7. `src/main/remote/index.ts` — `RemoteModule` supervisor.
8. `src/main/index.ts` (the `makeBridge` factory + `sendPrompt`/`interruptTurn`/`resolveApproval` wiring) — the integration point.
9. `src/renderer-remote/chat.tsx` — the PWA's main surface (event handling, reconnect, watchdog).
10. `src/renderer-remote/wire.ts` — thin transport helpers.
11. `src/renderer/components/settings/MobileRemoteSection.tsx` — settings panel pattern.
12. `src/renderer/state/store.ts` `attachSession` — the desktop's "attach to unknown session" logic.

## The single most important lesson

> **The wire is easier than the integration.** Building the bridge server, the auth flow, the event protocol — all of that landed cleanly via TDD with very few surprises. Every bug we shipped came from the **boundary** between the new remote module and the existing app: the agent's event emit shape, the renderer's session ownership model, the input queue assumptions, the renderer state that gated visibility. Plan for that boundary first; the wire follows.
