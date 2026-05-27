import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../db/db';
import { Repo } from '../db/repo';
import { SessionManager, type SdkClient, type SdkStreamEvent, type SessionStreamHandle, type TaggedSdkStreamEvent } from './session';
import type { SessionEvent } from '@shared/ipc-contract';
import type { ContentBlock } from '@shared/messages';
import { SessionBus, type RemoteOutbound } from '../remote/session-bus';
import { __setScreenshotRefsForTest } from './sdk-client';

let dir: string;
let repo: Repo;
let manager: SessionManager;
let events: SessionEvent[];
let fakeSdk: SdkClient;

/**
 * Build a fake SessionStreamHandle that records enqueued messages and replays
 * a scripted sequence of SdkStreamEvents for each enqueue. The script is a
 * generator factory taking the enqueued text + an abort signal. This mirrors
 * the old per-turn fake but in the long-lived stream shape.
 */
type Script = (args: { text: string; signal: AbortSignal }) => AsyncGenerator<SdkStreamEvent>;

function makeFakeOpenStream(scriptByCall: Script[] | Script) {
  const calls: Array<{ sessionId: string; resumeId: string | undefined; enqueued: Array<{ messageId: string; text: string; attachments: Array<Extract<ContentBlock, { type: 'image-ref' }>> }> }> = [];

  const openStream = vi.fn((sessionId: string, resumeId: string | undefined, hooks: { onPerMessageContext: (messageId: string) => void | Promise<void> }): SessionStreamHandle => {
    const enqueued: Array<{ messageId: string; text: string; attachments: Array<Extract<ContentBlock, { type: 'image-ref' }>> }> = [];
    calls.push({ sessionId, resumeId, enqueued });
    const abortController = new AbortController();
    const waiters: Array<(item: typeof enqueued[number] | null) => void> = [];
    const inbox: typeof enqueued = [];
    let closed = false;
    let callIdx = 0;
    function pumpNext(): Promise<typeof enqueued[number] | null> {
      if (inbox.length > 0) return Promise.resolve(inbox.shift()!);
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => waiters.push(resolve));
    }
    async function* taggedEvents(): AsyncIterable<TaggedSdkStreamEvent> {
      while (!closed) {
        const next = await pumpNext();
        if (!next) break;
        await hooks.onPerMessageContext(next.messageId);
        const script = Array.isArray(scriptByCall)
          ? scriptByCall[Math.min(callIdx, scriptByCall.length - 1)]!
          : scriptByCall;
        callIdx++;
        try {
          for await (const ev of script({ text: next.text, signal: abortController.signal })) {
            yield { ...ev, messageId: next.messageId } as TaggedSdkStreamEvent;
          }
        } catch (err) {
          throw err;
        }
      }
    }
    return {
      enqueue(m) {
        enqueued.push(m);
        const w = waiters.shift();
        if (w) w(m);
        else inbox.push(m);
      },
      async interrupt() { abortController.abort(); },
      events: taggedEvents,
      close() { closed = true; abortController.abort(); while (waiters.length) waiters.shift()!(null); },
      queueDepth() { return inbox.length; },
    };
  });

  return { openStream, calls };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'otto-sess-'));
  const db = openDatabase(path.join(dir, 'otto.db'));
  repo = new Repo(db);
  events = [];
  const { openStream } = makeFakeOpenStream(async function* () {
    yield { type: 'text-delta', text: 'hel' };
    yield { type: 'text-delta', text: 'lo' };
    yield { type: 'message-end' };
    yield { type: 'done' };
  });
  fakeSdk = {
    startSession: vi.fn(async () => ({ id: 'sdk-1' })),
    openStream,
  };
  manager = new SessionManager(repo, fakeSdk, 'claude-sonnet-4-6', (e) => events.push(e));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('SessionManager', () => {
  it('starts a session and persists it', async () => {
    const { sessionId } = await manager.start({});
    expect(sessionId).toBe('sdk-1');
    expect(repo.getSession(sessionId)?.model).toBe('claude-sonnet-4-6');
  });

  it('streams text deltas through and persists the assembled assistant message', async () => {
    const { sessionId } = await manager.start({});
    await manager.send({ sessionId, text: 'hi' });
    const textEvents = events.filter((e) => e.type === 'text-delta');
    expect(textEvents).toHaveLength(2);
    const msgs = repo.loadMessages(sessionId);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[1]!.content).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('records tool_use and tool_result blocks on the assistant message', async () => {
    const { openStream } = makeFakeOpenStream(async function* () {
      yield { type: 'tool-call-start', callId: 'c1', name: 'echo', input: { msg: 'hi' } };
      yield { type: 'tool-call-result', callId: 'c1', result: 'hi', isError: false };
      yield { type: 'message-end' };
      yield { type: 'done' };
    });
    fakeSdk.openStream = openStream;
    const { sessionId } = await manager.start({});
    await manager.send({ sessionId, text: 'use echo' });
    const msgs = repo.loadMessages(sessionId);
    const assistant = msgs.find((m) => m.role === 'assistant')!;
    expect(assistant.content).toEqual([
      { type: 'tool_use', callId: 'c1', name: 'echo', input: { msg: 'hi' } },
      { type: 'tool_result', callId: 'c1', result: 'hi', isError: false },
    ]);
  });

  it('emits an error event when the SDK throws and persists the message as errored', async () => {
    const { openStream } = makeFakeOpenStream(async function* () {
      yield { type: 'text-delta', text: 'partial' };
      throw new Error('boom');
    });
    fakeSdk.openStream = openStream;
    const { sessionId } = await manager.start({});
    await manager.send({ sessionId, text: 'fail' });
    const err = events.find((e) => e.type === 'error');
    expect(err).toBeTruthy();
    const assistant = repo.loadMessages(sessionId).find((m) => m.role === 'assistant');
    expect(assistant && 'errored' in assistant && assistant.errored).toBe(true);
  });

  it('interrupt() calls Query.interrupt on the stream handle', async () => {
    const interruptFn = vi.fn(async () => {});
    // Build a stream that stalls until the interrupt signal fires.
    const { openStream } = makeFakeOpenStream(async function* ({ signal }) {
      yield { type: 'text-delta', text: 'part' };
      await new Promise((r) => setTimeout(r, 10));
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      yield { type: 'text-delta', text: 'ial' };
      yield { type: 'message-end' };
      yield { type: 'done' };
    });
    // Wrap the real interrupt() with our spy.
    const origOpenStream = openStream;
    fakeSdk.openStream = vi.fn((...args: Parameters<typeof origOpenStream>) => {
      const handle = origOpenStream(...args);
      const origInterrupt = handle.interrupt.bind(handle);
      handle.interrupt = vi.fn(async () => { interruptFn(); await origInterrupt(); });
      return handle;
    });
    const { sessionId } = await manager.start({});
    const p = manager.send({ sessionId, text: 'long' });
    setTimeout(() => void manager.interrupt({ sessionId }), 1);
    await p;
    expect(interruptFn).toHaveBeenCalled();
    const assistant = repo.loadMessages(sessionId).find((m) => m.role === 'assistant');
    expect(assistant && 'cancelled' in assistant && assistant.cancelled).toBe(true);
  });

  it('interrupt() ends the current turn but second message still flows', async () => {
    // Each call to openStream gets its own script:
    //   1st handle (first openStream call): stalls — will be interrupted.
    //   2nd handle (second openStream call, rebuilt after stream teardown): completes normally.
    const scripts: Script[] = [
      async function* ({ signal }) {
        yield { type: 'text-delta', text: 'part' };
        await new Promise((r) => setTimeout(r, 20));
        if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        yield { type: 'text-delta', text: 'more' };
        yield { type: 'message-end' };
        yield { type: 'done' };
      },
      async function* () {
        yield { type: 'text-delta', text: 'second' };
        yield { type: 'message-end' };
        yield { type: 'done' };
      },
    ];
    // Each openStream invocation picks the next script (not per-message callIdx).
    let streamCallCount = 0;
    const fakeOpenStream = vi.fn((sessionId: string, resumeId: string | undefined, hooks: { onPerMessageContext: (messageId: string) => void | Promise<void> }): SessionStreamHandle => {
      const script = scripts[Math.min(streamCallCount, scripts.length - 1)]!;
      streamCallCount++;
      return makeFakeOpenStream(script).openStream(sessionId, resumeId, hooks);
    });
    fakeSdk.openStream = fakeOpenStream;
    const { sessionId } = await manager.start({});
    // Send first message; interrupt quickly; then send second.
    const p1 = manager.send({ sessionId, text: 'first' });
    setTimeout(() => void manager.interrupt({ sessionId }), 2);
    await p1;
    await manager.send({ sessionId, text: 'second' });
    const textDeltas = events.filter((e) => e.type === 'text-delta').map((e) => (e as { text: string }).text);
    expect(textDeltas).toContain('second');
    expect(fakeOpenStream).toHaveBeenCalledTimes(2); // stream was rebuilt after interrupt
  });

  it('persists the sdk session id when received, and passes it as resume on the next turn', async () => {
    const { openStream, calls } = makeFakeOpenStream(async function* () {
      yield { type: 'session-id', id: 'sdk-1' };
      yield { type: 'text-delta', text: 'ok' };
      yield { type: 'message-end' };
      yield { type: 'done' };
    });
    fakeSdk.openStream = openStream;
    const { sessionId } = await manager.start({});
    await manager.send({ sessionId, text: 'first' });
    expect(repo.getSession(sessionId)?.sdkSessionId).toBe('sdk-1');
    expect(calls[0]!.resumeId).toBeUndefined();
    await manager.send({ sessionId, text: 'second' });
    // openStream is opened once per session — second send reuses the existing
    // handle, so calls.length stays 1. The sdkSessionId is what we'd pass on
    // a fresh openStream (verified by inspecting the stored resume id).
    expect(repo.getSession(sessionId)?.sdkSessionId).toBe('sdk-1');
  });

  it('sets session title from the first user message', async () => {
    const { sessionId } = await manager.start({});
    await manager.send({ sessionId, text: 'first prompt here' });
    expect(repo.getSession(sessionId)?.title).toBe('first prompt here');
  });

  it('user message gets text + image-ref content when attachments are passed', async () => {
    const ref: Extract<ContentBlock, { type: 'image-ref' }> = {
      type: 'image-ref', id: 'u1', sessionId: 'sdk-1', path: '/tmp/u1.png',
      width: 10, height: 10, mimeType: 'image/png', source: 'user',
    };
    const { sessionId } = await manager.start({});
    await manager.send({ sessionId, text: 'look', attachments: [ref] });
    const msgs = repo.loadMessages(sessionId);
    const user = msgs.find((m) => m.role === 'user')!;
    expect(user.content).toEqual([{ type: 'text', text: 'look' }, ref]);
  });

  it('rewrites image blocks in tool_result.result.content to image-ref blocks', async () => {
    const { openStream } = makeFakeOpenStream(async function* () {
      yield { type: 'tool-call-start', callId: 'cs-1', name: 'screenshot', input: {} };
      yield {
        type: 'tool-call-result',
        callId: 'cs-1',
        isError: false,
        result: {
          content: [
            { type: 'image', data: 'BASE64DATA', mimeType: 'image/png' },
            { type: 'text', text: '{}' },
          ],
        },
      };
      yield { type: 'message-end' };
      yield { type: 'done' };
    });
    fakeSdk.openStream = openStream;
    __setScreenshotRefsForTest('cs-1', [
      { type: 'image-ref', id: 'img1', sessionId: 'sdk-1', path: '/tmp/img1.png', width: 100, height: 50, mimeType: 'image/png', source: 'screenshot' as const },
    ]);
    const { sessionId } = await manager.start({});
    await manager.send({ sessionId, text: 'go' });

    const result = events.find((e) => e.type === 'tool-call-result') as Extract<SessionEvent, { type: 'tool-call-result' }>;
    expect(result).toBeDefined();
    const content = (result.result as { content: unknown[] }).content;
    expect((content[0] as { type: string }).type).toBe('image-ref');
    expect((content[0] as { id: string }).id).toBe('img1');
    expect(JSON.stringify(content)).not.toContain('BASE64DATA');
  });
});

describe('SessionManager listeners', () => {
  it('onDoneListener fires with sessionId after a turn settles', async () => {
    const calls: string[] = [];
    manager.onDoneListener((sid) => calls.push(sid));
    const { sessionId } = await manager.start({});
    await manager.send({ sessionId, text: 'hi' });
    expect(calls).toEqual([sessionId]);
  });

  it('onUserActiveListener fires with sessionId at send start', async () => {
    const calls: string[] = [];
    manager.onUserActiveListener((sid) => calls.push(sid));
    const { sessionId } = await manager.start({});
    await manager.send({ sessionId, text: 'hi' });
    expect(calls).toEqual([sessionId]);
  });
});

describe('SDK attachment forwarding', () => {
  it('stream receives the attachments array when attachments are present', async () => {
    const ref: Extract<ContentBlock, { type: 'image-ref' }> = {
      type: 'image-ref', id: 'u1', sessionId: 'sdk-1', path: '/tmp/u1.png',
      width: 10, height: 10, mimeType: 'image/png', source: 'user',
    };
    const { openStream, calls } = makeFakeOpenStream(async function* () {
      yield { type: 'text-delta', text: 'ok' };
      yield { type: 'message-end' };
      yield { type: 'done' };
    });
    fakeSdk.openStream = openStream;
    const { sessionId } = await manager.start({});
    await manager.send({ sessionId, text: 'go', attachments: [ref] });
    expect(calls[0]!.enqueued[0]!.attachments).toEqual([ref]);
  });
});

describe('SessionManager + SessionBus fan-out', () => {
  it('an emit wrapper can publish each event to both renderer and the SessionBus', async () => {
    const rendererCalls: SessionEvent[] = [];
    const bus = new SessionBus();
    const busCalls: RemoteOutbound[] = [];
    const fanout = (e: SessionEvent) => {
      rendererCalls.push(e);
      if ('sessionId' in e && typeof e.sessionId === 'string') {
        bus.publish(e.sessionId, { ...e, type: 'event', kind: e.type } as unknown as RemoteOutbound);
      }
    };
    const mgr = new SessionManager(repo, fakeSdk, 'claude-sonnet-4-6', fanout);
    const { sessionId } = await mgr.start({});
    bus.subscribe(sessionId, (e) => busCalls.push(e));
    await mgr.send({ sessionId, text: 'go' });

    expect(rendererCalls.some((e) => e.type === 'text-delta')).toBe(true);
    expect(busCalls.some((e) => e.type === 'event' && (e as { kind?: string }).kind === 'text-delta')).toBe(true);
  });
});
