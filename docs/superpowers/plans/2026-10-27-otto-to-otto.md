# Otto-to-Otto Delegation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one Otto delegate a natural-language task to a paired Otto on another tailnet machine, stream the remote work live into the local chat, and answer the remote's approvals and sudo prompts locally.

**Architecture:** The remote machine's existing mobile-remote `BridgeServer` gains a `delegate` frame (busy-aware, starts a fresh session) and starts honouring prompt origin so its remote ceiling actually applies. The local machine gets a `PeerStore` (paired machines), a `PeerClient` (WS client of a remote bridge, same protocol as the phone PWA), a pure reducer that folds remote events into a compact snapshot, and two agent tools (`delegate_to_machine`, `wait_for_machine`) that publish that snapshot as `tool-call-snapshot` events so the existing ToolCallCard renders it live.

**Tech Stack:** Electron main (Node), TypeScript, `ws`, better-sqlite3, zod 3.25, React renderer, vitest.

**Spec:** `docs/superpowers/specs/2026-10-27-otto-to-otto-design.md`

## Global Constraints

- Package manager is pnpm (`pnpm install --frozen-lockfile`); never `npm install`.
- Run tests with `pnpm vitest run <path> --maxWorkers=2`. Never run tests while a packaging build is running (better-sqlite3 ABI flip).
- Typecheck: `pnpm typecheck`.
- Stay on zod 3.25; tool schemas must be `z.object(...)` (sdk-client pulls `.shape`).
- Bridge port stays 17829; transport stays plain HTTP by default (`plainHttp: !process.env.OTTO_REMOTE_HTTPS`). No cert pinning in v1.
- Other Ottos share the phone's `remoteCeiling`; no new ceiling setting.
- Catastrophic matches from `origin: 'remote'` are auto-denied; remote approvers can never approve a catastrophic match (existing `DecisionBroker.resolve` rule).
- No screenshots in the delegation view in v1: image blocks in remote results render as the placeholder text `[image]`.
- One turn at a time per Otto: never start a delegated turn while the remote is mid-turn.
- Delegated task text must be self-contained (remote has no local context).
- Peer bearer tokens are encrypted with Electron `safeStorage` when `isEncryptionAvailable()`; otherwise stored as-is with a logged warning.

## Review Focus

1. **Remote is idle but has an old conversation open.** Delegation must start a *new* session, not append to the old one. Test: Task 2 `delegate frame starts a new session even when an idle session is active`.
2. **The phone keeps working.** The phone PWA's `prompt`, `approval`, `sudo` frames must behave exactly as before, except that remote-origin policy now applies. Test: Task 2 `prompt frame still targets the active session`, plus the existing `end-to-end.test.ts` stays green.
3. **Huge remote tool results** (multi-MB stdout, base64 screenshots) must not bloat the local snapshot, the local model's context, or RAM. Test: Task 5 `truncates long results and replaces images`.
4. **Connection drops mid-task.** The local side must reconnect and catch up without duplicating items, and fall back to `/sessions/:id/messages` when `/history` is truncated. Test: Task 4 `reconnects and backfills from history without duplicates`.
5. **Approval answered on the remote screen first.** The local card's pending approval must clear when `tool-call-decided` arrives from either side. Test: Task 5 `clears pending approval on tool-call-decided`.

---

### Task 1: Thread prompt origin through to the decision broker

The fix the user asked for: bridge prompts currently run under the desktop's full autonomy mode.

**Files:**
- Modify: `src/main/agent/session.ts` (`SessionManager.send`, new `originForMessage`, new `hasActiveTurn`)
- Modify: `src/main/agent/sdk-client.ts` (`ToolCtx`, `RealSdkClientDeps`, the `broker.decide` call at ~line 419)
- Modify: `src/main/index.ts` (bridge `sendPrompt` passes `origin`; wire `originForMessage` into sdk deps)
- Test: `src/main/agent/session.test.ts`, `src/main/agent/sdk-client` origin test (add to the nearest existing test that builds the MCP server, or a new `src/main/agent/origin.test.ts`)

**Interfaces:**
- Produces:
  - `SessionManager.send(args: { sessionId; text; attachments?; voice?; origin?: 'desktop' | 'remote' })` — default `'desktop'`.
  - `SessionManager.originForMessage(messageId: string): 'desktop' | 'remote'` — origin recorded for the assistant messageId created by `send`; unknown ids return `'desktop'`. Entries are dropped when the message finalizes.
  - `SessionManager.hasActiveTurn(sessionId?: string): boolean` — true while any assistant message for that session (or any session, when omitted) is started and not finalized/cancelled.
  - `ToolCtx.getOrigin: (messageId: string) => 'desktop' | 'remote'`, sourced from `RealSdkClientDeps.originForMessage`.

- [ ] **Step 1: Write failing tests**

```ts
it('records remote origin for the assistant message created by send', async () => {
  const { mgr } = makeManager();            // existing session.test.ts helper
  const { sessionId } = await mgr.start({});
  const p = mgr.send({ sessionId, text: 'hi', origin: 'remote' });
  const assistantId = lastAssistantIdFrom(emitted); // from the user-message-queued event
  expect(mgr.originForMessage(assistantId)).toBe('remote');
  expect(mgr.hasActiveTurn(sessionId)).toBe(true);
  finishTurn(); await p;
  expect(mgr.hasActiveTurn(sessionId)).toBe(false);
});
it('defaults origin to desktop', /* send without origin → 'desktop' */);
it('passes origin to broker.decide for tool calls in a remote turn', async () => {
  // build the otto MCP server with ctx.getOrigin = () => 'remote' and a spy broker;
  // invoke shell_exec; expect(spy.decide).toHaveBeenCalledWith(expect.objectContaining({ origin: 'remote' }))
});
```

- [ ] **Step 2: Run** `pnpm vitest run src/main/agent --maxWorkers=2` — Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the interfaces above. In `index.ts`, the bridge `sendPrompt: async (text, origin, attachments)` passes `origin` through to `sessions.send`; desktop IPC sends stay unchanged (default `'desktop'`). The broker call passes `origin: ctx.getOrigin(messageId)`.
- [ ] **Step 4: Run** `pnpm vitest run src/main/agent src/main/autonomy src/main/remote --maxWorkers=2` and `pnpm typecheck` — Expected: all PASS.
- [ ] **Step 5: Commit** `fix(autonomy): apply remote ceiling to bridge-originated turns`

---

### Task 2: Bridge `delegate` frame and session-scoped approvals

**Files:**
- Modify: `src/main/remote/bridge-server.ts` (new `delegate` frame; widen `approval` decision)
- Modify: `src/main/index.ts` (wire new `BridgeServerOpts` hooks)
- Modify: `src/renderer-remote/wire.ts` (types only: add frames to `WsOutboundFrame` / `WsInboundFrame`)
- Test: `src/main/remote/bridge-server.test.ts`

**Interfaces:**
- Consumes: `SessionManager.hasActiveTurn`, `send({ origin: 'remote' })` (Task 1).
- Produces (wire, all with `v: 1`):
  - Client → server: `{ type: 'delegate'; text: string; correlationId: string; sessionId?: string; ifBusy?: 'reject' | 'interrupt' }`. No `sessionId` = new session; with `sessionId` = follow-up in that session.
  - Server → client: `{ type: 'delegate_started'; correlationId; sessionId }` | `{ type: 'delegate_busy'; correlationId; activeSessionId: string | null }` | `{ type: 'delegate_err'; correlationId; message }`.
  - `approval` frame `decision` now accepts `'approve' | 'approve-session' | 'deny'`.
- New `BridgeServerOpts`:
  - `isBusy?: () => boolean`
  - `startDelegation?: (args: { text: string; sessionId?: string; interruptFirst: boolean }) => Promise<{ sessionId: string }>` — in `index.ts`: if `interruptFirst`, interrupt the active session and await its `done`. Then start a new session (or `start({ resume: sessionId })` for a follow-up). Then call `sessions.send({ sessionId, text, origin: 'remote' })` **without awaiting turn completion**, and return the id.
  - `resolveApproval` signature widened to `(decisionId, choice: 'approve' | 'approve-session' | 'deny') => boolean`.

- [ ] **Step 1: Write failing tests** in `bridge-server.test.ts`:
  - `delegate frame starts a new session even when an idle session is active` → `startDelegation` called with `{ sessionId: undefined, interruptFirst: false }`; client receives `delegate_started` with the returned id.
  - `delegate frame replies delegate_busy when isBusy() and ifBusy is reject` → `startDelegation` not called.
  - `delegate with ifBusy interrupt calls startDelegation with interruptFirst true`.
  - `delegate follow-up passes sessionId through`.
  - `approval frame forwards approve-session`.
  - `prompt frame still targets the active session` (regression for the phone).
- [ ] **Step 2: Run** `pnpm vitest run src/main/remote/bridge-server.test.ts --maxWorkers=2` — Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the frame handling in `handleWs` and the `index.ts` wiring. The new session must become the remote desktop window's visible conversation, exactly as the existing `newSession` hook does today. Follow-ups go through `delegate` with `sessionId`, not through `prompt`. This deliberately leaves the phone's `prompt` frame untouched; it departs from the spec's "honour prompt's sessionId" note to avoid changing phone behaviour. Busy means `isBusy()` and `ifBusy !== 'interrupt'`; `ifBusy` defaults to `'reject'`. Errors from `startDelegation` become `delegate_err`.
- [ ] **Step 4: Run** `pnpm vitest run src/main/remote --maxWorkers=2` — Expected: PASS, including the existing `end-to-end.test.ts`.
- [ ] **Step 5: Commit** `feat(remote): delegate frame with busy handling; session-scoped remote approvals`

---

### Task 3: Peer store (paired machines on the controlling side)

**Files:**
- Modify: `src/main/db/db.ts` (migration 8)
- Create: `src/main/peers/peer-store.ts`
- Test: `src/main/peers/peer-store.test.ts`, `src/main/db/db.test.ts` (migration 008)

**Interfaces:**
- Migration `MIGRATION_008_PEERS`: table `peers(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, base_url TEXT NOT NULL, token_enc BLOB NOT NULL, token_is_encrypted INTEGER NOT NULL, device_id TEXT NOT NULL, paired_at INTEGER NOT NULL)`.
- Produces:
  - `interface Peer { id: string; name: string; baseUrl: string; deviceId: string; pairedAt: number }`
  - `interface TokenCipher { encrypt(s: string): { data: Buffer; encrypted: boolean }; decrypt(data: Buffer, encrypted: boolean): string }`
  - `class PeerStore { constructor(db, cipher: TokenCipher, now?: () => number); add(p: { name; baseUrl; deviceId; token }): Peer; list(): Peer[]; findByName(name: string): Peer | null; token(id: string): string; remove(id: string): void }`
  - `safeStorageCipher(): TokenCipher` in the same file. It uses Electron `safeStorage`, falling back to plaintext with `logger.warn` once.
- `findByName` matching: case-insensitive exact match on `name`; otherwise a unique case-insensitive prefix match; otherwise `null`.

- [ ] **Step 1: Write failing tests** with an identity-ish fake cipher: add/list round-trip; `token()` returns the plaintext; duplicate name (any case) throws; `findByName('BAZ')` finds `bazzite`; an ambiguous prefix returns `null`; `remove` deletes. Migration test: the `peers` table exists with the columns above.
- [ ] **Step 2: Run** `pnpm vitest run src/main/peers src/main/db/db.test.ts --maxWorkers=2` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(peers): store paired Otto machines`

---

### Task 4: PeerClient — talk to a remote Otto's bridge

**Files:**
- Create: `src/main/peers/peer-client.ts`
- Test: `src/main/peers/peer-client.test.ts` (end-to-end against a real `BridgeServer`, using the setup pattern from `src/main/remote/end-to-end.test.ts`)

**Interfaces:**
- Consumes: wire frames from Task 2; `/pair`, `/history`, `/sessions/:id/messages` routes (existing).
- Produces:
  - `parsePairingUrl(url: string): { baseUrl: string; code: string }` — accepts the URL produced by `RemoteModule.mintPairingCode()` (`http(s)://host:port/?code=...`); throws `Error('Not an Otto pairing link')` otherwise.
  - `pairWithPeer(baseUrl: string, code: string, deviceLabel: string): Promise<{ token: string; deviceId: string }>` — `deviceLabel` is `Otto on ${os.hostname()}`.
  - Uses `RemoteEvent` from `src/shared/delegation.ts` (Task 5 owns that file; Task 4 creates it with just this type if Task 5 hasn't landed): `type RemoteEvent = { type: string; kind?: string; sessionId?: string; [k: string]: unknown }` — a raw fanned-out bridge frame.
  - `class PeerClient { constructor(opts: { baseUrl: string; token: string; connectTimeoutMs?: number /* default 5000 */; reconnectWindowMs?: number /* default 60000 */ }); connect(): Promise<void>; delegate(args: { text: string; sessionId?: string; ifBusy?: 'reject' | 'interrupt' }): Promise<{ kind: 'started'; sessionId: string } | { kind: 'busy'; activeSessionId: string | null }>; onEvent(sessionId: string, cb: (e: RemoteEvent) => void): () => void; decide(decisionId: string, decision: 'approve' | 'approve-session' | 'deny'): void; sudo(promptId: string, password: string | null): void; interrupt(sessionId: string): void; onConnectionChange(cb: (state: 'connected' | 'reconnecting' | 'lost') => void): () => void; close(): void }`
  - `connect()` rejects with `Error('unreachable')` after `connectTimeoutMs` when the host doesn't answer, and with `Error('unauthorized')` on WS close code 4001.
- Reconnect: on unexpected close, retry with backoff until `reconnectWindowMs` elapses, then emit `'lost'`. After reauth, for each subscribed session fetch `/history?session_id=&since=<lastSeq>` and replay events with `seq > lastSeq`. If `truncated`, fetch `/sessions/:id/messages` and emit one synthetic `{ type: 'event', kind: 'backfill-messages', messages }` event. Live frames carry no `seq`, so track `lastSeq` by fetching `/history` once right after `delegate_started`, and dedupe replayed events against what was already delivered (compare `callId`, `messageId`, and `kind`).

- [ ] **Step 1: Write failing tests:**
  - `pairs with a minted code and connects`.
  - `connect rejects unreachable within the timeout` (port with no listener, `connectTimeoutMs: 300`).
  - `connect rejects unauthorized for a revoked token`.
  - `delegate returns started and streams that session's events` (server `startDelegation` publishes `text-delta` then `done` on the bus).
  - `delegate returns busy`.
  - `decide/sudo/interrupt send the right frames` (assert via the server hooks).
  - `reconnects and backfills from history without duplicates` (stop and restart the server mid-stream on the same port).
- [ ] **Step 2: Run** `pnpm vitest run src/main/peers/peer-client.test.ts --maxWorkers=2` — Expected: FAIL.
- [ ] **Step 3: Implement** with `ws` and global `fetch`.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(peers): client for remote Otto bridges`

---

### Task 5: Delegation snapshot reducer

A pure function that folds remote events into what the card shows and what the model gets back.

**Files:**
- Create: `src/shared/delegation.ts` (shared so the renderer can type the snapshot)
- Test: `src/shared/delegation.test.ts`

**Interfaces:**
- Produces:
  - `RemoteEvent` (exact type in Task 4's Interfaces) is exported from this file.
  - ```ts
    type DelegationItem =
      | { kind: 'text'; text: string }
      | { kind: 'tool'; callId: string; name: string; summary: string; status: 'running' | 'done' | 'error' | 'denied'; result?: string };
    interface DelegationSnapshot {
      v: 1; machine: string; remoteSessionId: string | null;
      status: 'connecting' | 'busy' | 'running' | 'done' | 'interrupted' | 'error' | 'lost';
      items: DelegationItem[];
      pendingApproval: { decisionId: string; name: string; input: unknown; actionClass: ActionClass; reason: string; catastrophic: boolean } | null;
      pendingSudo: { promptId: string; command: string; error?: string } | null;
      finalText: string; error?: string;
    }
    ```
  - `initialSnapshot(machine: string): DelegationSnapshot`
  - `reduceDelegation(s: DelegationSnapshot, e: RemoteEvent): DelegationSnapshot` — maps `kind` values `message-start`, `text-delta`, `tool-call-start`, `tool-call-result`, `tool-call-denied`, `tool-call-pending`, `tool-call-decided`, `sudo-prompt`, `sudo-resolved`, `message-cancelled` (→ `interrupted`), `error`, `done`, and `backfill-messages`. `finalText` = text after the last tool call.
  - `summarizeForModel(s: DelegationSnapshot): string` — `"<machine>: <status>. <finalText>"` plus the names of denied tools, ≤ 2000 chars.
  - Limits: tool `result` ≤ 2000 chars (truncated with `…`); image/image-ref blocks become `[image]`; at most 200 items (oldest dropped).
- `summary` on tool items uses `summarizeInput(name, input)` from `@shared/tool-presenters`.

- [ ] **Step 1: Write failing tests:** a text-delta stream accumulates; a tool start/result pair produces one done item; `truncates long results and replaces images`; a pending approval is set and then `clears pending approval on tool-call-decided`; the sudo prompt is set and cleared; `message-cancelled` → `interrupted`; `done` → `done` with `finalText` = text after the last tool; `summarizeForModel` caps at 2000 chars.
- [ ] **Step 2: Run** `pnpm vitest run src/shared/delegation.test.ts --maxWorkers=2` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(peers): delegation snapshot reducer`

---

### Task 6: Delegation manager and agent tools

**Files:**
- Create: `src/main/peers/delegations.ts`
- Modify: `src/main/agent/sdk-client.ts` (register tools, `ToolCtx.peers`, system prompt lines, machine list)
- Modify: `src/main/index.ts` (construct `PeerStore`, `DelegationManager`; interrupt propagation)
- Modify: `src/main/notifier.ts` (`notifyRemoteApproval`)
- Test: `src/main/peers/delegations.test.ts`

**Interfaces:**
- Consumes: `PeerStore` (Task 3), `PeerClient` (Task 4), `reduceDelegation` / `summarizeForModel` (Task 5).
- Produces:
  - `class DelegationManager { constructor(deps: { store: PeerStore; makeClient: (p: Peer, token: string) => PeerClient; notifyApproval: (machine: string, toolName: string) => void; snapshotThrottleMs?: number /* 250 */; waitCapMs?: number /* 600000 */ }); run(args: { localSessionId: string; machine: string; task: string; ifBusy: 'ask' | 'wait' | 'interrupt'; followUp: boolean; emitSnapshot: (s: DelegationSnapshot) => void; registerKill: (k: () => void) => void }): Promise<string>; wait(args: { localSessionId: string; machine: string; emitSnapshot; registerKill }): Promise<string>; decide(machine: string, decisionId: string, d: 'approve' | 'approve-session' | 'deny'): void; sudo(machine: string, promptId: string, pw: string | null): void; interruptAllFor(localSessionId: string): void; machineNames(): string[] }`
  - One delegation per (localSessionId, machine) is tracked so `followUp: true` reuses its `remoteSessionId`, and `wait` reattaches to it.
- `run` behaviour and return strings (these are what the model sees):
  - Unknown machine → `Unknown machine "<x>". Paired machines: a, b.` If none are paired → `No machines are paired. Pair one in Settings → Other machines.`
  - Unreachable → `<machine>'s Otto isn't reachable — is it on and is Remote enabled in its settings?`
  - Busy with `ifBusy: 'ask'` → `<machine> is busy with another task. Ask the user whether to wait for it or interrupt it, then call again with if_busy "wait" or "interrupt".`
  - `ifBusy: 'wait'` → poll `delegate` every 5 s until started or the wait cap is hit.
  - Running past `waitCapMs` → `Still running on <machine>. Call wait_for_machine to keep watching.`
  - Finished → `summarizeForModel(snapshot)`.
  - Connection `'lost'` → `Lost connection to <machine>; the task may still be running there.`
- Each new `pendingApproval` triggers `notifyApproval` once.
- Tools (`OttoTool` in `delegations.ts`, built with a factory taking the manager and registered in `buildOttoMcpServer` only when `machineNames().length > 0`):
  - `delegate_to_machine` — schema `z.object({ machine: z.string(), task: z.string().min(1), if_busy: z.enum(['ask','wait','interrupt']).optional(), follow_up: z.boolean().optional() })`; `actionClass: 'reversible'`; `actionClassFor` returns `'destructive'` when `if_busy === 'interrupt'`.
  - `wait_for_machine` — schema `z.object({ machine: z.string() })`; `actionClass: 'read'`.
  - Both pass `io.emitSnapshot` / `io.registerKill` through. The kill handler calls `client.interrupt(remoteSessionId)`.
- System prompt: when machines are paired, append a short section. It lists the machine names. It says to use `delegate_to_machine` when the user asks for something on another machine, to write the task self-contained in the second person ("Quit the Slack app."), and to relay the result in one or two lines. It also says to never pick `if_busy: 'interrupt'` without the user's say-so.
- In `index.ts`, the existing `session.interrupt` IPC path also calls `delegations.interruptAllFor(sessionId)`.

- [ ] **Step 1: Write failing tests** with a fake `PeerClient`: each return string above; follow-up reuses the remote session id; `wait` reattaches; snapshot emits are throttled (fake timers); `notifyApproval` fires once per decisionId; `interruptAllFor` interrupts only that local session's delegations; `actionClassFor` returns destructive for interrupt.
- [ ] **Step 2: Run** `pnpm vitest run src/main/peers --maxWorkers=2` — Expected: FAIL.
- [ ] **Step 3: Implement** and wire into `sdk-client.ts` / `index.ts` / `notifier.ts`.
- [ ] **Step 4: Run** `pnpm vitest run src/main --maxWorkers=2` and `pnpm typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(peers): delegate_to_machine and wait_for_machine tools`

---

### Task 7: Live delegation card in the chat

**Files:**
- Modify: `src/shared/tool-presenters.ts` (`ResultView` gains `{ kind: 'delegation'; snapshot: DelegationSnapshot }`; `classifyResult` and `describeTool` handle both tool names)
- Create: `src/renderer/components/DelegationView.tsx`
- Modify: `src/renderer/components/ToolResultRenderer.tsx` (render `delegation`)
- Modify: `src/renderer/components/ApprovalCard.tsx`, `SudoPromptCard.tsx` (optional `onDecide` / `onSubmit` props that replace the default IPC call)
- Modify: `src/shared/ipc-contract.ts`, `src/preload/*`, `src/main/ipc/handlers.ts` (channels `peers:decide`, `peers:sudo`)
- Test: `src/renderer/components/DelegationView.test.tsx`, `src/shared/tool-presenters.test.ts`

**Interfaces:**
- Consumes: `DelegationSnapshot` (Task 5); `DelegationManager.decide/sudo` (Task 6).
- `classifyResult` for `delegate_to_machine` / `wait_for_machine`: a snapshot object (`v === 1`, has `items`) → `delegation`; a final string result → `markdown`. The final result stays a plain string for the model. While running, `partialSnapshot` drives the live view.
- IPC: `peers:decide { machine; decisionId; decision: 'approve' | 'approve-session' | 'deny' } → void`; `peers:sudo { machine; promptId; password: string | null } → void`.
- `describeTool`: title `Working on <machine>` (machine read from the input), and the existing icon set's closest network/remote icon.
- `DelegationView`: header with machine name and status; the items list (text as markdown, tools as compact rows with status dot and summary); a pending approval rendered via `ApprovalCard` with `onDecide`, adapting `pendingApproval` to the `pending_tool_use` block shape; a pending sudo via `SudoPromptCard` with `onSubmit`. Catastrophic approvals show only Deny, plus the note `Approve this one at <machine>.`

- [ ] **Step 1: Write failing tests:** `classifyResult` returns `delegation` for a snapshot; `DelegationView` renders the items; clicking Approve calls `ipc.invoke('peers:decide', { machine, decisionId, decision: 'approve' })`; a catastrophic approval shows only Deny; the sudo submit calls `peers:sudo`.
- [ ] **Step 2: Run** `pnpm vitest run src/renderer/components/DelegationView.test.tsx src/shared/tool-presenters.test.ts --maxWorkers=2` — Expected: FAIL.
- [ ] **Step 3: Implement**, matching the existing card styling (Plus Jakarta Sans, near-black/violet; refine in place, no new visual language).
- [ ] **Step 4: Run** `pnpm vitest run src/renderer src/shared --maxWorkers=2` and `pnpm typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(peers): live delegation card with local approvals`

---

### Task 8: "Other machines" settings section

**Files:**
- Create: `src/renderer/components/settings/OtherMachinesSection.tsx`
- Modify: the settings panel that mounts `MobileRemoteSection` (mount the new section beneath it)
- Modify: `src/shared/ipc-contract.ts`, `src/preload/*`, `src/main/ipc/handlers.ts` (channels below)
- Test: `src/renderer/components/settings/OtherMachinesSection.test.tsx`, handler tests next to existing remote handler tests if present

**Interfaces:**
- IPC:
  - `peers:list → Array<{ id; name; baseUrl; pairedAt; online: boolean }>` — `online` comes from a `GET <baseUrl>/sessions?limit=1` with a 2 s timeout, using the bearer token.
  - `peers:add { name; pairingUrl } → { id }` — `parsePairingUrl` → `pairWithPeer` → `PeerStore.add`. Error copy surfaced to the UI: `That link has expired — make a new one on the other machine.` (401), `Couldn't reach that machine.` (network), `You already have a machine called "<name>".` (duplicate).
  - `peers:remove { id } → void`.
- UI: a list of machines (name, online dot, Forget button) and an "Add machine" form with two fields: "Pairing link" ("On the other machine: Settings → Mobile remote → Pair a device, then copy the link") and "Name" (prefilled from the link's host up to the first dot). The section stays visible even when Mobile remote is disabled on this machine.

- [ ] **Step 1: Write failing tests:** the list renders machines with their online state; adding calls `peers:add` and refreshes; each error message renders; Forget calls `peers:remove`.
- [ ] **Step 2: Run** `pnpm vitest run src/renderer/components/settings --maxWorkers=2` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command plus `pnpm typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(peers): settings section to pair other machines`

---

### Task 9: Full verification and manual smoke

**Files:**
- Create: `docs/superpowers/notes/2026-10-27-otto-to-otto-manual-smoke.md`

- [ ] **Step 1: Run** `pnpm vitest run --maxWorkers=2` and `pnpm typecheck` — Expected: all PASS.
- [ ] **Step 2: Write the smoke checklist** covering both spec examples between two real machines: pair Mac→Bazzite; ask "quit the Slack app on my mac" from the Bazzite; ask the Sunshine investigation from the Mac and approve a destructive step locally; approve one step on the remote screen and confirm the local card clears; interrupt from the local Stop button; delegate while the remote is mid-turn and walk through both the wait and interrupt answers; kill the remote's network mid-task and confirm the "lost connection" result; confirm a catastrophic command is auto-denied; confirm the phone PWA still works.
- [ ] **Step 3: Commit** `docs: Otto-to-Otto manual smoke checklist`
