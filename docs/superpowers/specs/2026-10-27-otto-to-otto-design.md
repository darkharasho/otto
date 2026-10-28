# Otto-to-Otto: delegate tasks to other machines over Tailscale

Date: 2026-10-27
Status: draft, awaiting approval (decisions on remote-origin fix and busy handling made by user 2026-10-27)

## Intent

The user runs Otto on several machines on one Tailscale tailnet (e.g. a Mac and a
Bazzite gaming PC). From whichever machine they're sitting at, they want to ask
their local Otto to do something **on another machine**, in plain language:

- "shut down the slack app on my mac" — a quick errand.
- "on my bazzite I can't connect with Sunshine, can you investigate and fix it?" —
  a long, multi-step investigation on the other box.

The why: the user shouldn't have to walk to (or remote-desktop into) the other
machine to get Otto's help there. Otto's value is acting, and the problem is often
on a machine other than the one in front of them.

## What the user decided

- **Watch it live and approve from here.** While the remote Otto works, the
  user follows along in their local Otto window (remote tool calls stream in) and
  approves risky steps / answers sudo prompts from the local machine.
- **Natural-language targeting.** The machine is named inside the request ("on my
  mac", "on my bazzite"); the user doesn't switch to a special mode first.
- **Fix remote-origin enforcement as part of this work.** Today the bridge drops
  the prompt's origin (`sendPrompt: async (text, _origin, …)` in
  `src/main/index.ts`), `SessionManager.send` has no origin parameter, and no
  `broker.decide` call in `src/main/agent/sdk-client.ts` passes `origin` — so the
  remote ceiling and "catastrophic + remote ⇒ auto-deny" never fire for phone or
  bridge prompts. Thread origin through so every tool decision in a turn started
  from the bridge is evaluated with `origin: 'remote'`. The user accepts that this
  changes phone behaviour too (their saved ceiling starts applying; catastrophic
  commands from the phone/another Otto are auto-denied). Other Ottos share the
  phone's ceiling setting — no separate setting.
- **Busy remote.** If the remote Otto is mid-turn when a delegation arrives, the
  delegation does not start; the tool returns "bazzite is busy" and the local Otto
  asks the user whether to wait (poll until idle, then start) or interrupt the
  remote's current turn and then start. If the remote is idle, the delegated task
  starts as a new session that also becomes the remote machine's active session,
  so it's visible on the remote screen.

## Calls made by the designer (overridable)

- **The remote Otto does the work.** The local Otto delegates the task text; the
  remote machine's Otto runs its own agent session with its own tools, platform
  adapter, and per-machine knowledge file. The local agent does *not* drive the
  remote machine's tools one by one. Reason: the remote Otto knows its own OS and
  quirks, and this reuses the whole existing agent stack unchanged.
- **Pair each machine once with a code**, reusing the existing mobile-remote
  pairing (`PairingStore`, `/pair`, bearer token). Being on the same tailnet is
  not enough to be trusted — tailnets can include shared/work devices. The user
  didn't pick between this and "auto-trust the tailnet"; this is the safer default.
- **Reuse the mobile-remote bridge protocol as-is** (`src/main/remote/`:
  `BridgeServer`, `SessionBus`, WS frames in `src/renderer-remote/wire.ts`). A
  local Otto becomes one more client of a remote Otto's bridge, exactly like the
  phone PWA. New frame types only where unavoidable.
- **Delegation is a tool** on the local agent (working name `delegate_to_machine`,
  input: `{ machine, task }`). The local model decides when a request targets
  another machine and which one, matching against the paired machines' names.
- **Each delegation starts a fresh session on the remote** so the remote task
  isn't mixed into whatever the remote user/Otto was last doing. The local model
  may send follow-up prompts into that same remote session within one local
  conversation (e.g. "ok now restart it"). The bridge `prompt` frame already
  carries `sessionId` but the server ignores it — honour it (and refuse if it
  isn't the remote's active session) rather than adding a new field.
- **Plain HTTP over the tailnet, same as the phone.** Production runs the bridge
  with `plainHttp: !process.env.OTTO_REMOTE_HTTPS`; Tailscale's WireGuard layer
  encrypts the link. No cert pinning in v1. If `OTTO_REMOTE_HTTPS` is set on the
  remote, the client should accept its self-signed cert by pinning the
  fingerprint seen at pairing — but plain HTTP is the supported default.
- **No screenshots in the live view in v1.** The bridge's screenshot route is a
  stub (`loadScreenshot: async () => null`) and nothing signs screenshot URLs into
  the event fan-out. v1 streams text and tool calls only; tool results that
  contain images show a placeholder.
- **"Approve for this session" works from the controlling machine**, scoped to the
  delegated remote session only, so a long investigation doesn't re-prompt for
  every repeated step. Requires extending the bridge `approval` frame to accept
  `approve-session` (the desktop broker already supports it). The catastrophic
  rule still wins: remote approvers can never approve a catastrophic match.
- **No time cap on delegated tasks.** `delegate_to_machine` blocks until the
  remote turn ends (the builder must confirm the SDK tool-call timeout allows
  this, and fall back to a start/status split if not). On reconnect, catch up via
  `/history?since=`; if that returns `truncated` (the ring is 200 events / 8 MB,
  in memory), fall back to `/sessions/:id/messages`.

## How it behaves

1. **Setup (once per machine pair).** On the target machine (e.g. Bazzite), the
   user enables Remote in settings (already exists) and mints a pairing code
   (already exists; produces a URL with the code). On the controlling machine
   (Mac), a new "Other machines" settings section lets the user paste that URL
   (or host + code) and give the machine a friendly name ("bazzite"). The Mac's
   Otto pairs as a device labelled with its own hostname, stores the token and the
   remote's TLS cert fingerprint, and the machine now appears in the list with
   online/offline status. Pairing is one-directional; to control the Mac from the
   Bazzite, pair the other way too.
2. **Asking.** User types "on my bazzite I can't connect with Sunshine…". The local
   agent calls `delegate_to_machine({ machine: "bazzite", task: "<rephrased
   self-contained task>" })`. The task text must be self-contained — the remote
   Otto has none of the local conversation's context.
3. **Watching.** The tool call renders as a "Working on bazzite" card in the local
   chat. Inside it, the remote session's events stream live: assistant text and
   tool calls with their results (no screenshots in v1). Collapsible, like other
   long-running tool cards.
4. **Approving.** What actually reaches bridge clients today is fanned-out session
   events (`type: 'event'`) with `kind` values such as `tool-call-pending`,
   `tool-call-decided`, `sudo-prompt`, and `done` — this is what the PWA's
   `src/renderer-remote/chat.tsx` handles. (The `approval_pending` /
   `approval_resolved` types declared in `session-bus.ts` are never published.)
   When a pending approval or sudo prompt arrives, the local card shows it in
   place; the answer goes back over the bridge (`approval` / `sudo` frames). The
   remote machine's own window can also answer — first answer wins.
   The local window should grab attention (same as a local approval) when a
   remote approval is pending.
5. **Stopping.** The local card's Stop button sends `interrupt` for that remote
   session. Interrupting the local turn also interrupts the delegated remote turn.
6. **Result.** When the remote turn ends, the tool returns a concise summary
   (the remote's final assistant message, plus whether it completed, failed, or
   was interrupted) to the local agent, which reports back to the user in one or
   two lines.

## Safety

- The remote Otto's own safety rules are authoritative: its hard denylist, its
  autonomy mode, and its **remote ceiling** (`RemoteCeiling` in
  `src/main/autonomy/policy.ts`). Once origin is threaded through (see decisions
  above), delegated prompts are evaluated as `origin: 'remote'`, so the ceiling
  the user configured for their phone applies to other Ottos too, and
  catastrophic matches are auto-denied.
- The local side adds no ability to bypass remote approvals. Local approval is
  only a convenient place to answer them.
- `delegate_to_machine` itself is classified `reversible` on the local side (it's
  sending a message; the remote gates the actual actions). It should not require
  its own local approval in balanced mode — otherwise every delegation double-prompts.
- Transport: plain HTTP over the tailnet by default (see decisions). The bridge
  binds only to the tailnet IP, and every request needs a paired bearer token.
- Revocation: the target machine's existing paired-devices list shows the
  controlling Otto and can revoke it. The controlling side can "forget" a machine.

## Goals

- Both example requests work end-to-end between a Mac and a Linux box, either direction.
- Live streaming of the remote session in the local chat, with approvals and sudo
  answerable locally.
- Works across Linux / macOS / Windows (all already run the bridge).

## Non-goals

- No auto-discovery/auto-trust of every Otto on the tailnet. (A nice-to-have
  later: list tailnet peers running an Otto bridge on port 17829 to make pairing
  easier — still requiring a code.)
- No screenshots in the live view (v1).
- No concurrent turns on one Otto; a busy remote is waited on or interrupted.
- No fan-out to multiple machines in one tool call ("quit Slack everywhere"); the
  local model can call the tool once per machine if needed.
- No file transfer between machines beyond what the remote Otto can already do.
- No relaying through a third machine; direct tailnet connections only.
- Not replacing the phone PWA.

## Anti-goals (would be a failure even if it "works")

- A device that merely joins the tailnet can command an Otto without pairing.
- A delegated task can do something the remote Otto would have blocked or
  required approval for if typed at the remote machine directly.
- The user can't tell what the remote machine is doing until it's finished.
- Delegated work silently stalls on a remote approval nobody sees.

## Edge cases to handle

- Remote machine offline / Otto not running / bridge disabled: tool fails fast
  with a clear message ("bazzite's Otto isn't reachable — is it on and is Remote
  enabled?"), no long hang.
- Connection drops mid-task: the remote keeps working; the local side reconnects
  and catches up via `/history?since=<seq>` (already exists). If it can't
  reconnect within a reasonable window, the tool returns "lost connection; task
  may still be running on bazzite".
- Unknown machine name: the tool errors listing the paired machine names so the
  model can ask the user or pick correctly.
- Remote approval timeout: existing remote-side expiry applies; surface the
  resulting deny in the card.
- Local Otto window closed/hidden while a delegated task runs: same as any long
  local tool call.

## Left to the builder

- Where the bridge client lives (main process, likely `src/main/remote/peer-client.ts`
  using `ws`) and how its events are piped to the renderer card.
- Exact card UI, reusing ToolCallCard / approval-card / screenshot rendering from
  the renderer and the PWA (`src/renderer-remote/approval-card.tsx`,
  `sudo-prompt-card.tsx`, `tool-result-renderer.tsx`) where practical.
- How "turn ended" is detected (the `done` event kind is the likely signal) and
  how "remote is busy" is exposed (e.g. via `session_state` or a new small frame).
- How `new_session` + `prompt` avoid racing the remote user's own activity (a
  combined "new session with prompt" frame is fine).
- Note: `currentMessageId` in `src/main/index.ts` is a single global used by the
  broker; the busy rule (one turn at a time) means no concurrent-session refactor
  is needed, but don't introduce a path that runs two turns at once.
- Storage of peer tokens: keep secrets out of plain settings JSON (use Electron
  `safeStorage` or the existing DB).
- Prompt guidance added to the local agent's system prompt about when to delegate
  and how to write a self-contained task.
- Tests following the existing patterns in `src/main/remote/*.test.ts`, including
  an end-to-end test of one Otto client against a real `BridgeServer`.
