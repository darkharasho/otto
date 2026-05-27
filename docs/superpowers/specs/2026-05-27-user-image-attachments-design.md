# User Image Attachments

**Date:** 2026-05-27
**Status:** Design — pending implementation plan

## Problem

Today Otto only accepts plain text in user messages. The user can't show Otto a picture they took on their phone, drag a screenshot from their desktop onto the bar, or paste an image from their clipboard. With the `ImageRef` architecture now in place (shipped 2026-05-26), the infrastructure to carry image refs end-to-end exists; this spec extends it to user-originated images.

## Goals

1. Desktop: paste from clipboard, drag-and-drop a file onto the input, and a file-picker button.
2. Mobile (PWA over WS bridge): paste from clipboard, file picker (which surfaces camera + library on iOS/Android natively).
3. Storage: bytes saved to disk once under a new `<configDir>/user-uploads/<sessionId>/` root. In-memory representation is `ImageRef`.
4. Send shape: image attachments are part of the user message. Sending text+image is the default; sending image-alone (no text) is allowed.
5. Bytes only materialize twice: at IPC-receive (briefly, while writing to disk) and at the Anthropic API call (loaded from disk, base64-encoded inline, freed after the SDK consumes the message).

## Non-goals

- Non-image attachments (PDF, audio, video). v1 is images only — PNG/JPEG/WebP/GIF, matching what Claude's API accepts.
- Editing or annotating attachments before send.
- Persisting attachments across sessions (each upload belongs to one session and is wiped with the session via the existing orphan sweep).
- Per-image size optimization (downscale before upload). Deferred — Claude handles oversized images and the disk store is bounded by the session lifecycle.

## Architecture

### Type extension

Extend `ImageRef` (`src/shared/messages.ts:37-45`) with a discriminator so the UI can label the source:

```ts
| {
    type: 'image-ref';
    id: string;
    sessionId: string;
    path: string;
    width: number;
    height: number;
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
    source: 'screenshot' | 'user';
  };
```

All call sites that build `image-ref` blocks set `source` explicitly. Existing screenshot path sets `source: 'screenshot'`. User uploads set `source: 'user'`.

`UserMessage` is unchanged structurally: its `content: ContentBlock[]` already supports a mix of `text` and `image-ref` blocks (the latter was previously only used in assistant tool_results, but the union accepts it anywhere).

### Disk store

New module `src/main/user-uploads/store.ts`:

```ts
export async function saveUserUpload(
  bytes: Buffer,
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif',
  sessionId: string,
  configDir: string,
): Promise<ImageRef>;
```

Writes to `<configDir>/user-uploads/<sessionId>/<uuid>.<ext>`. Returns an `ImageRef` with `source: 'user'`. Uses `nativeImage` (already in the screenshot path) to read width/height from the buffer.

The startup orphan sweep at `src/main/index.ts` extends to also scan `<configDir>/user-uploads/`. Same `sweepOrphanScreenshots(root, knownSessionIds)` function — generalize its name to `sweepOrphanDir` or call it twice with different roots. The wipe-on-reset handler at `src/main/ipc/handlers.ts:182` also wipes user-uploads.

### `otto-image://` protocol

Register a second Electron protocol `otto-user-image://` that reuses the existing `resolveImageRequest` (now passed a different root) and a widened filename regex to accept `.png|.jpg|.jpeg|.webp|.gif`.

- `otto-image://<sessionId>/<id>.<ext>` → `<configDir>/screenshots/`
- `otto-user-image://<sessionId>/<id>.<ext>` → `<configDir>/user-uploads/`

`SAFE_FILE` in `src/main/screenshot/protocol.ts` widens to `^[A-Za-z0-9_-]+\.(png|jpg|jpeg|webp|gif)$`. The two `registerOttoImageProtocol`-style functions are siblings; both call the same resolver with their own root.

Renderer chooses the URL prefix from `ref.source`:

```ts
const scheme = ref.source === 'user' ? 'otto-user-image' : 'otto-image';
const src = `${scheme}://${ref.sessionId}/${ref.id}.${extFromMime(ref.mimeType)}`;
```

`extFromMime` is a tiny pure helper in `src/shared/messages.ts` (or a sibling util):
- `image/png` → `png`
- `image/jpeg` → `jpg`
- `image/webp` → `webp`
- `image/gif` → `gif`

### IPC contract

`src/shared/ipc-contract.ts`:

- Extend `SessionSendArgs`:
  ```ts
  type SessionSendArgs = { sessionId: string; text: string; attachments?: ImageRef[] };
  ```
- New handler `uploads.stage`: accepts a sessionId + `{ bytes: Uint8Array; mimeType }`, returns the saved `ImageRef`. The renderer calls this for each pasted/dropped/picked file before submitting.

`src/main/ipc/handlers.ts` adds the `uploads.stage` handler that calls `saveUserUpload`.

### Session manager + SDK send

`src/main/agent/session.ts#send`:
- Accept `attachments?: ImageRef[]` on the args.
- Build the user message content as `[{type:'text', text}, ...attachments.map(a => a)]` (image-ref blocks). Empty `text` is allowed — content array is just the images.
- Pass attachments through to `sdk.sendTurn`.

`src/main/agent/sdk-client.ts#sendTurn`:
- New signature: `sendTurn(sessionId, text, attachments, signal, resumeId)`.
- When no attachments: keep `prompt: text` (string) — unchanged hot path.
- When attachments present: switch to `prompt: AsyncIterable<SDKUserMessage>` (which the SDK supports per `node_modules/@anthropic-ai/claude-agent-sdk/entrypoints/agentSdkTypes.d.ts:31-34`). Yield one `SDKUserMessage` whose `message` is an `APIUserMessage` with content:
  ```ts
  [
    { type: 'text', text },
    ...attachments.map(a => ({
      type: 'image',
      source: { type: 'base64', media_type: a.mimeType, data: await fsp.readFile(a.path, 'base64') },
    })),
  ]
  ```
- Bytes are read from disk just-in-time, in the iterator, freed after the SDK consumes them.

### Desktop renderer — input

`src/renderer/components/CommandBar.tsx`:

- Add an attachment row above the text input showing thumbnail chips for each staged image with a small "×" to remove.
- Add a paperclip-icon button that opens a hidden `<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple>`.
- Listen for `paste` events on the form: if `clipboardData.items` contains image files, call `uploads.stage` for each and append to the staging list.
- Listen for `dragover` (preventDefault) and `drop` on the form: collect `dataTransfer.files`, filter by mime type, stage each.
- Replace the text-only submit with `onSubmit({ text, attachments })`. Allow submit when `text.trim().length > 0 || attachments.length > 0`.

The current input is `<input type="text">` (single-line). Keep single-line for v1 — attachments don't need a textarea.

### Mobile renderer — input

`src/renderer-remote/chat.tsx`:

- Mirror the chip row + paperclip button + paste handler. The `<input type="file" accept="image/*" multiple>` on mobile pops the OS picker, which on iOS/Android offers camera + library — gets us camera capture for free without writing a camera UI.
- Submit calls a new WS frame:
  ```ts
  { v: 1, type: 'prompt', sessionId, text, attachmentIds: ['ref-id-1', ...] }
  ```
  Where each attachment was uploaded first via a separate WS frame `{ v: 1, type: 'attach', sessionId, mimeType, bytesBase64 }` that returns an `ImageRef` (or just an id the server remembers).

### WS bridge inbound contract

`src/main/remote/session-bus.ts`:

```ts
type RemoteInbound =
  | { type: 'prompt'; sessionId: string; text: string; origin: 'desktop' | 'remote'; attachmentIds?: string[] }
  | { type: 'attach'; sessionId: string; mimeType: string; bytesBase64: string; clientCorrelationId: string }
  | ...
```

`src/main/remote/bridge-server.ts`:
- New WS message handler for `attach`: saves via `saveUserUpload`, returns `{ type: 'attach_ok', clientCorrelationId, ref: ImageRef }` to the same WS connection.
- `prompt` handler now also accepts `attachmentIds[]`. It resolves them via a per-session in-memory map `Map<sessionId, Map<refId, ImageRef>>` populated by the `attach` handler.

The mobile flow stages attachments first (one WS frame per file), then sends the prompt referencing those staged ids. This avoids putting big base64 strings inside the prompt frame.

### Rendering user messages with images

`src/renderer/components/Message.tsx` (and the renderer-remote equivalent in `chat.tsx`): for user messages, walk `content[]` and render each block — `text` as today, `image-ref` as `<img src={ottoUrl(ref)}>` with the existing `loading="lazy"` pattern.

The classifier in `src/shared/tool-presenters.ts` is for tool _results_, not user messages — no change needed there. The user-message renderer in `Message.tsx` does its own per-block switch.

## Migration

No persisted data changes shape. Old user messages have `[{type:'text', text}]` only; new ones can have mixed content. Renderers handle both.

## Verification

- Unit: `user-uploads/store.test.ts` — write, returns ref with correct dimensions, correct mime-type-to-extension mapping.
- Unit: protocol resolver extension — extend `protocol.test.ts` to cover `otto-user-image://` and non-PNG extensions.
- Unit: `session.test.ts` — `manager.send({ sessionId, text, attachments: [ref] })` produces a user-message event with `[text, image-ref]` content; SDK gets a structured prompt (assert via the fake SDK seeing an `AsyncIterable` rather than a string).
- Unit: bridge — `attach` frame stages a file and returns a ref; `prompt` frame with `attachmentIds` resolves them.
- Integration (manual): paste a screenshot into the desktop bar, send, verify Claude responds about it. Same on the phone bridge with a photo.

## Files touched (summary)

**Modified:**
- `src/shared/messages.ts` — extend `ImageRef` with `source` and broaden `mimeType`
- `src/shared/ipc-contract.ts` — `SessionSendArgs.attachments?`; new `uploads.stage` channel; bridge `RemoteInbound` additions
- `src/main/ipc/handlers.ts` — `uploads.stage` handler
- `src/main/screenshot/protocol.ts` — generalize extension regex; register second protocol
- `src/main/screenshot/cleanup.ts` — usable for two roots (rename or call twice)
- `src/main/agent/session.ts` — accept attachments in `send`; thread to SDK
- `src/main/agent/sdk-client.ts` — `sendTurn` accepts attachments; switches to `AsyncIterable<SDKUserMessage>` when present
- `src/main/index.ts` — register `otto-user-image://` protocol; extend startup sweep
- `src/main/remote/session-bus.ts` — `RemoteInbound` shape additions
- `src/main/remote/bridge-server.ts` — `attach` + extended `prompt` handlers; per-session staging map
- `src/renderer/components/CommandBar.tsx` — attachment row, paste/drop/picker
- `src/renderer/components/Message.tsx` — render `image-ref` blocks in user messages
- `src/renderer/state/store.ts` — `appendUserMessage` accepts `attachments`
- `src/renderer-remote/chat.tsx` — same as desktop, plus WS staging
- `src/renderer-remote/wire.ts` (or equivalent) — new WS frame types

**New:**
- `src/main/user-uploads/store.ts` and `store.test.ts`
