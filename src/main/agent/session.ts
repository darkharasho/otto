import type { Repo } from '../db/repo';
import type { SessionEvent, StructuredError } from '@shared/ipc-contract';
import { logger } from '../logger';
import {
  newAssistantMessage,
  newUserMessage,
  type AssistantMessage,
  type ContentBlock,
} from '@shared/messages';

export type SdkStreamEvent =
  | { type: 'message-start' }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call-start'; callId: string; name: string; input: unknown }
  | { type: 'tool-call-result'; callId: string; result: unknown; isError: boolean }
  | { type: 'message-end' }
  | { type: 'done' }
  | { type: 'session-id'; id: string };

export interface SdkTurn {
  signal: AbortSignal;
  events(): AsyncIterable<SdkStreamEvent>;
}

export interface SdkClient {
  startSession(args: { resume?: string; model: string }): Promise<{ id: string }>;
  sendTurn(sessionId: string, text: string, signal: AbortSignal, resumeId?: string): SdkTurn;
}

type Emitter = (event: SessionEvent) => void;

export class SessionManager {
  private readonly aborts = new Map<string, AbortController>();
  private activeSessionId: string | null = null;

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

  async send(args: { sessionId: string; text: string }): Promise<void> {
    const { sessionId, text } = args;
    const user = this.repo.appendMessage({ ...newUserMessage(text), sessionId });
    this.repo.setSessionTitleIfMissing(sessionId, text.slice(0, 80));
    this.repo.updateSessionActivity(sessionId, Date.now(), 'active');

    const assistant: AssistantMessage & { sessionId: string } = {
      ...newAssistantMessage(),
      sessionId,
    };
    const controller = new AbortController();
    this.aborts.set(sessionId, controller);
    this.activeSessionId = sessionId;

    this.onAssistantMessageId(assistant.id);
    this.emit({ type: 'message-start', sessionId, messageId: assistant.id });

    try {
      const resumeId = this.repo.getSession(sessionId)?.sdkSessionId ?? undefined;
      const turn = this.sdk.sendTurn(sessionId, text, controller.signal, resumeId);
      for await (const ev of turn.events()) {
        switch (ev.type) {
          case 'message-start':
            // already emitted
            break;
          case 'session-id': {
            this.repo.setSdkSessionId(sessionId, ev.id);
            break;
          }
          case 'text-delta': {
            appendText(assistant.content, ev.text);
            this.emit({ type: 'text-delta', sessionId, messageId: assistant.id, text: ev.text });
            break;
          }
          case 'tool-call-start': {
            assistant.content.push({ type: 'tool_use', callId: ev.callId, name: ev.name, input: ev.input });
            this.emit({
              type: 'tool-call-start',
              sessionId,
              messageId: assistant.id,
              callId: ev.callId,
              name: ev.name,
              input: ev.input,
            });
            break;
          }
          case 'tool-call-result': {
            assistant.content.push({
              type: 'tool_result',
              callId: ev.callId,
              result: ev.result,
              isError: ev.isError,
            });
            this.emit({
              type: 'tool-call-result',
              sessionId,
              messageId: assistant.id,
              callId: ev.callId,
              result: ev.result,
              isError: ev.isError,
            });
            break;
          }
          case 'message-end': {
            this.emit({ type: 'message-end', sessionId, messageId: assistant.id });
            break;
          }
          case 'done': {
            this.emit({ type: 'done', sessionId });
            break;
          }
        }
        if (controller.signal.aborted) throw new AbortLikeError();
      }
    } catch (err) {
      // If we requested the abort, any downstream failure (including the
      // claude-code subprocess exiting non-zero because it was killed) is a
      // cancellation, not a real error. Without this check the SDK's
      // "Claude Code process exited with code 1" leaks through as an error
      // card whenever the user hits Stop.
      if (isAbort(err) || controller.signal.aborted) {
        assistant.cancelled = true;
        this.emit({ type: 'message-cancelled', sessionId, messageId: assistant.id });
      } else {
        assistant.errored = true;
        const structured = toStructuredError(err);
        logger.error('SDK turn failed', err);
        this.emit({ type: 'error', sessionId, error: structured });
      }
    } finally {
      this.aborts.delete(sessionId);
      this.repo.appendMessage(assistant);
      this.repo.updateSessionActivity(sessionId, Date.now(), assistant.errored ? 'idle' : 'active');
      // Always tell the renderer the turn is over — without this, an aborted
      // turn leaves the UI stuck in `streaming: true` because the SDK's
      // generator finally-yielded `done` never reaches our outer consumer.
      this.emit({ type: 'done', sessionId });
      void user;
    }
  }

  cancel(args: { sessionId: string }): void {
    this.aborts.get(args.sessionId)?.abort();
  }
}

class AbortLikeError extends Error {
  name = 'AbortError';
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
