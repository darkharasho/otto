import type { Repo } from '../db/repo';
import type { SessionEvent, StructuredError } from '@shared/ipc-contract';
import { logger } from '../logger';
import {
  newAssistantMessage,
  newUserMessage,
  type AssistantMessage,
  type ContentBlock,
} from '@shared/messages';
import { consumeScreenshotRefs } from './sdk-client';

function normalizeImageBlocks(callId: string, result: unknown): unknown {
  if (typeof result !== 'object' || result === null) return result;
  const r = result as { content?: unknown[] };
  if (!Array.isArray(r.content)) return result;
  const refs = consumeScreenshotRefs(callId);
  if (!refs) return result;
  // Replace image blocks in positional order with the recorded refs.
  let refIdx = 0;
  const nextContent = r.content.map((block) => {
    if (
      typeof block === 'object' && block !== null &&
      (block as { type?: unknown }).type === 'image' &&
      refIdx < refs.length
    ) {
      return refs[refIdx++];
    }
    return block;
  });
  return { ...r, content: nextContent };
}

export type SdkStreamEvent =
  | { type: 'message-start' }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call-start'; callId: string; name: string; input: unknown }
  | { type: 'tool-call-result'; callId: string; result: unknown; isError: boolean }
  | { type: 'message-end' }
  | { type: 'done' }
  | { type: 'session-id'; id: string };

export type TaggedSdkStreamEvent = SdkStreamEvent & { messageId: string };

export interface SessionStreamHandle {
  enqueue(args: { messageId: string; text: string; attachments: Array<Extract<ContentBlock, { type: 'image-ref' }>> }): void;
  interrupt(): Promise<void>;
  events(): AsyncIterable<TaggedSdkStreamEvent>;
  close(): void;
  queueDepth(): number;
}

export interface SdkClient {
  startSession(args: { resume?: string; model: string }): Promise<{ id: string }>;
  openStream(
    sessionId: string,
    resumeId: string | undefined,
    hooks: { onPerMessageContext: (messageId: string) => void | Promise<void> },
  ): SessionStreamHandle;
}

type Emitter = (event: SessionEvent) => void;

interface ActiveAssistant {
  message: AssistantMessage & { sessionId: string };
  started: boolean;
  done: Promise<void>;
  resolveDone: () => void;
}

export class SessionManager {
  private readonly aborts = new Map<string, AbortController>();
  private readonly streams = new Map<string, SessionStreamHandle>();
  private readonly assistants = new Map<string, Map<string, ActiveAssistant>>(); // sessionId -> (messageId -> active)
  private readonly seenSdkSessionId = new Set<string>();
  private activeSessionId: string | null = null;
  private readonly doneListeners: Array<(sessionId: string) => void> = [];
  private readonly userActiveListeners: Array<(sessionId: string) => void> = [];

  constructor(
    private readonly repo: Repo,
    private readonly sdk: SdkClient,
    private readonly defaultModel: string,
    private readonly emit: Emitter,
    private readonly onAssistantMessageId: (messageId: string) => void = () => {}
  ) {}

  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  onDoneListener(cb: (sessionId: string) => void): void {
    this.doneListeners.push(cb);
  }

  onUserActiveListener(cb: (sessionId: string) => void): void {
    this.userActiveListeners.push(cb);
  }

  async start(args: { resume?: string; model?: string }): Promise<{ sessionId: string }> {
    const model = args.model ?? this.defaultModel;
    const sdkSession = await this.sdk.startSession({ resume: args.resume, model });
    const now = Date.now();
    if (!this.repo.getSession(sdkSession.id)) {
      this.repo.createSession({
        id: sdkSession.id,
        model,
        createdAt: now,
        lastActive: now,
      });
    } else {
      this.repo.updateSessionActivity(sdkSession.id, now, 'active');
    }
    this.activeSessionId = sdkSession.id;
    return { sessionId: sdkSession.id };
  }

  private ensureStream(sessionId: string): SessionStreamHandle {
    const existing = this.streams.get(sessionId);
    if (existing) return existing;

    const resumeId = this.repo.getSession(sessionId)?.sdkSessionId ?? undefined;
    const handle = this.sdk.openStream(sessionId, resumeId, {
      onPerMessageContext: (messageId: string) => {
        // Notify caller (main/index.ts tracks currentMessageId for telemetry).
        try { this.onAssistantMessageId(messageId); } catch (err) {
          logger.warn(`onAssistantMessageId threw: ${err instanceof Error ? err.message : err}`);
        }
        // Emit user-message-consumed: the queued message is now being processed.
        this.emit({
          type: 'user-message-consumed',
          sessionId,
          messageId,
          queueDepth: handle.queueDepth(),
        });
      },
    });
    this.streams.set(sessionId, handle);

    // Spawn the long-lived consumer loop. Each event arrives tagged with the
    // messageId it belongs to; we look up the matching assistant row and
    // accumulate accordingly.
    void this.consumeStream(sessionId, handle);
    return handle;
  }

  private getOrCreateAssistant(sessionId: string, messageId: string): ActiveAssistant {
    let perSession = this.assistants.get(sessionId);
    if (!perSession) {
      perSession = new Map();
      this.assistants.set(sessionId, perSession);
    }
    let row = perSession.get(messageId);
    if (!row) {
      const created = newAssistantMessage();
      const message: AssistantMessage & { sessionId: string } = {
        ...created,
        id: messageId,
        sessionId,
      };
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => { resolveDone = resolve; });
      row = { message, started: false, done, resolveDone };
      perSession.set(messageId, row);
    }
    return row;
  }

  private async consumeStream(sessionId: string, handle: SessionStreamHandle): Promise<void> {
    try {
      for await (const ev of handle.events()) {
        const messageId = ev.messageId;
        switch (ev.type) {
          case 'session-id': {
            if (!this.seenSdkSessionId.has(sessionId)) {
              this.repo.setSdkSessionId(sessionId, ev.id);
              this.seenSdkSessionId.add(sessionId);
            }
            break;
          }
          case 'message-start': {
            // We emit message-start ourselves when we observe the first event
            // for a new messageId — see ensureStarted below.
            break;
          }
          case 'text-delta': {
            const row = this.getOrCreateAssistant(sessionId, messageId);
            this.ensureStarted(sessionId, row);
            appendText(row.message.content, ev.text);
            this.emit({ type: 'text-delta', sessionId, messageId, text: ev.text });
            break;
          }
          case 'tool-call-start': {
            const row = this.getOrCreateAssistant(sessionId, messageId);
            this.ensureStarted(sessionId, row);
            row.message.content.push({ type: 'tool_use', callId: ev.callId, name: ev.name, input: ev.input });
            this.emit({
              type: 'tool-call-start',
              sessionId,
              messageId,
              callId: ev.callId,
              name: ev.name,
              input: ev.input,
            });
            break;
          }
          case 'tool-call-result': {
            const row = this.getOrCreateAssistant(sessionId, messageId);
            this.ensureStarted(sessionId, row);
            const normalizedResult = normalizeImageBlocks(ev.callId, ev.result);
            row.message.content.push({
              type: 'tool_result',
              callId: ev.callId,
              result: normalizedResult,
              isError: ev.isError,
            });
            this.emit({
              type: 'tool-call-result',
              sessionId,
              messageId,
              callId: ev.callId,
              result: normalizedResult,
              isError: ev.isError,
            });
            break;
          }
          case 'message-end': {
            // Per-message completion: flush the assistant row, emit message-end + done.
            this.finalizeMessage(sessionId, messageId, { errored: false, cancelled: false });
            break;
          }
          case 'done': {
            // Per-message done (the underlying mapper emits this together with
            // message-end at end of a result). Finalization handles emit; we
            // can no-op here, but keep a fallback emit in case message-end was
            // skipped for some reason.
            break;
          }
        }
      }
    } catch (err) {
      // Fatal stream error — attribute to any in-flight assistant messages.
      const aborted = this.aborts.get(sessionId)?.signal.aborted ?? false;
      const perSession = this.assistants.get(sessionId);
      if (perSession) {
        for (const messageId of Array.from(perSession.keys())) {
          if (aborted || isAbort(err)) {
            this.finalizeMessage(sessionId, messageId, { errored: false, cancelled: true });
          } else {
            this.finalizeMessage(sessionId, messageId, { errored: true, cancelled: false });
          }
        }
      }
      if (!aborted && !isAbort(err)) {
        const structured = toStructuredError(err);
        logger.error('SDK stream failed', err);
        this.emit({ type: 'error', sessionId, error: structured });
      }
      // Tear down the stream so the next send() rebuilds it.
      this.streams.delete(sessionId);
      this.aborts.delete(sessionId);
      this.emit({ type: 'done', sessionId });
      for (const cb of this.doneListeners) {
        try { cb(sessionId); } catch (err2) { logger.warn(`done listener threw: ${err2 instanceof Error ? err2.message : err2}`); }
      }
    }
  }

  private ensureStarted(sessionId: string, row: ActiveAssistant): void {
    if (row.started) return;
    row.started = true;
    this.emit({ type: 'message-start', sessionId, messageId: row.message.id });
  }

  private finalizeMessage(
    sessionId: string,
    messageId: string,
    flags: { errored: boolean; cancelled: boolean },
  ): void {
    const perSession = this.assistants.get(sessionId);
    const row = perSession?.get(messageId);
    if (!row) return;
    perSession!.delete(messageId);
    if (flags.cancelled) {
      row.message.cancelled = true;
      this.emit({ type: 'message-cancelled', sessionId, messageId });
    } else if (flags.errored) {
      row.message.errored = true;
    } else {
      this.emit({ type: 'message-end', sessionId, messageId });
    }
    this.repo.appendMessage(row.message);
    this.repo.updateSessionActivity(sessionId, Date.now(), row.message.errored ? 'idle' : 'active');
    this.emit({ type: 'done', sessionId });
    for (const cb of this.doneListeners) {
      try { cb(sessionId); } catch (err) { logger.warn(`done listener threw: ${err instanceof Error ? err.message : err}`); }
    }
    row.resolveDone();
  }

  async send(args: { sessionId: string; text: string; attachments?: Array<Extract<ContentBlock, { type: 'image-ref' }>> }): Promise<void> {
    const { sessionId, text } = args;
    const user = this.repo.appendMessage({ ...newUserMessage(text, args.attachments ?? []), sessionId });
    this.emit({ type: 'user-message', sessionId, messageId: user.id, text, content: user.content });
    this.repo.setSessionTitleIfMissing(sessionId, text.slice(0, 80));
    this.repo.updateSessionActivity(sessionId, Date.now(), 'active');

    // Pre-create the assistant row with a stable id we can use to tag the
    // enqueued message. The stream consumer will populate it as events arrive.
    const assistantId = newAssistantMessage().id;
    const stream = this.ensureStream(sessionId);
    // Track ahead-of-time so events can find the row even if they arrive before
    // we'd otherwise getOrCreate. We also keep a handle on the done promise so
    // send() can await per-message completion (preserving the previous
    // per-turn await semantics).
    const row = this.getOrCreateAssistant(sessionId, assistantId);

    // Session-level abort controller still exists so cancel() can tear down
    // the underlying query. Tasks 5/6 will revisit semantics.
    if (!this.aborts.has(sessionId)) {
      this.aborts.set(sessionId, new AbortController());
    }
    this.activeSessionId = sessionId;
    for (const cb of this.userActiveListeners) {
      try { cb(sessionId); } catch (err) { logger.warn(`userActive listener threw: ${err instanceof Error ? err.message : err}`); }
    }

    this.onAssistantMessageId(assistantId);

    stream.enqueue({ messageId: assistantId, text, attachments: args.attachments ?? [] });
    this.emit({
      type: 'user-message-queued',
      sessionId,
      messageId: assistantId,
      queueDepth: stream.queueDepth(),
    });
    void user;
    await row.done;
  }

  async interrupt(args: { sessionId: string }): Promise<void> {
    // Interrupt the currently-streaming turn via the SDK stream handle.
    // This ends the current turn but keeps the session subprocess alive so
    // queued messages continue flowing. The AbortController is NOT aborted
    // here — that is reserved for hard-shutdown (session close / app quit).
    const stream = this.streams.get(args.sessionId);
    if (stream) {
      await stream.interrupt();
    }
  }

  /** @deprecated Use interrupt(). Hard-kills the underlying subprocess; kept for Task 6 closeSession path. */
  cancel(args: { sessionId: string }): void {
    this.aborts.get(args.sessionId)?.abort();
  }
}

function isAbort(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError';
}

function appendText(content: ContentBlock[], text: string): void {
  const last = content[content.length - 1];
  if (last && last.type === 'text') {
    last.text += text;
    return;
  }
  content.push({ type: 'text', text });
}

function toStructuredError(err: unknown): StructuredError {
  const message = err instanceof Error ? err.message : String(err);
  if (message.toLowerCase().includes('auth') || message.toLowerCase().includes('unauthorized')) {
    return { kind: 'auth-missing', message, retryable: true };
  }
  return { kind: 'sdk-stream', message, retryable: true };
}
