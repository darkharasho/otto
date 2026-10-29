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
import { __setScreenshotRefsForTest, buildOttoMcpServer, toSessionStreamHandle } from './sdk-client';
import { createSessionStream, type QueryFactory } from './session-stream';

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
        for await (const ev of script({ text: next.text, signal: abortController.signal })) {
          yield { ...ev, messageId: next.messageId } as TaggedSdkStreamEvent;
        }
      }
    }
    return {
      enqueue(m) {
        enqueued.push(m);
        const w = waiters.shift();
        if (w) w(m);
        else inbox.push(m);
        return 'turn';
      },
      async interrupt() { abortController.abort(); },
      events: taggedEvents,
      close() { closed = true; abortController.abort(); while (waiters.length) waiters.shift()!(null); },
      queueDepth() { return inbox.length; },
    };
  });

  return { openStream, calls };
}

/**
 * Eager mode: the real createSessionStream + sdk-client tagging in front of a
 * query fake that behaves like the bundled CLI: it reads the prompt iterable as
 * fast as it yields (as Query.streamInput does), echoes each prompt back as a
 * replay ack when it reads it, and runs one turn per idle-time batch of queued
 * prompts, each closed by a `result` (error_during_execution when the turn was
 * interrupted). `turn` scripts the raw SDK messages; calling `drain()` between
 * steps reads prompts queued meanwhile into the running turn.
 */
type EagerTurn = (args: { text: string; signal: AbortSignal; drain: () => unknown[] }) => AsyncGenerator<unknown>;

function makeEagerOpenStream(turn: EagerTurn) {
  const pulled: string[] = [];
  const openStream = vi.fn((sessionId: string, _resumeId: string | undefined, hooks: { onPerMessageContext: (messageId: string) => void | Promise<void> }): SessionStreamHandle => {
    const queryFactory: QueryFactory = ({ prompt }) => {
      const cliQueue: Array<{ text: string; uuid: string }> = [];
      let wake = null as (() => void) | null;
      let inputDone = false;
      void (async () => {
        for await (const m of prompt) {
          pulled.push(m.message.content as string);
          cliQueue.push({ text: m.message.content as string, uuid: m.uuid! });
          wake?.();
        }
        inputDone = true;
        wake?.();
      })();
      const ack = (p: { text: string; uuid: string }) => ({ type: 'user', isReplay: true, uuid: p.uuid, message: { role: 'user', content: p.text } });
      let turnAbort = new AbortController();
      return {
        async *[Symbol.asyncIterator]() {
          while (true) {
            if (cliQueue.length === 0) {
              if (inputDone) return;
              await new Promise<void>((r) => { wake = r; });
              wake = null;
              continue;
            }
            const batch = cliQueue.splice(0);
            for (const p of batch) yield ack(p);
            turnAbort = new AbortController();
            const drain = () => cliQueue.splice(0).map(ack);
            yield* turn({ text: batch.map((p) => p.text).join('+'), signal: turnAbort.signal, drain });
            yield { type: 'result', subtype: turnAbort.signal.aborted ? 'error_during_execution' : 'success' };
          }
        },
        interrupt: async () => { turnAbort.abort(); },
      } as unknown as ReturnType<QueryFactory>;
    };
    const stream = createSessionStream({ sessionId, queryFactory, onPerMessageContext: (id) => hooks.onPerMessageContext(id) });
    return toSessionStreamHandle(stream);
  });
  return { openStream, pulled };
}

async function waitFor(pred: () => boolean, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
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
  manager = new SessionManager(repo, fakeSdk, 'claude-sonnet-5-5', (e) => events.push(e));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('SessionManager', () => {
  it('starts a session and persists it', async () => {
    const { sessionId } = await manager.start({});
    expect(sessionId).toBe('sdk-1');
    expect(repo.getSession(sessionId)?.model).toBe('claude-sonnet-5-5');
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

  it('folds annotate_result into the target tool_result instead of rendering it as blocks', async () => {
    const { openStream } = makeFakeOpenStream(async function* () {
      yield { type: 'tool-call-start', callId: 'c1', name: 'mcp__otto-tools__shell_exec', input: { command: 'iostat' } };
      yield { type: 'tool-call-result', callId: 'c1', result: { stdout: 'x\n', exitCode: 0 }, isError: false };
      yield { type: 'tool-call-start', callId: 'c2', name: 'mcp__otto-tools__annotate_result', input: { takeaway: 'indexer reading 212 MB/s during the hitch' } };
      yield { type: 'tool-call-result', callId: 'c2', result: 'noted', isError: false };
      yield { type: 'message-end' };
      yield { type: 'done' };
    });
    fakeSdk.openStream = openStream;
    const { sessionId } = await manager.start({});
    await manager.send({ sessionId, text: 'check disk' });
    const assistant = repo.loadMessages(sessionId).find((m) => m.role === 'assistant')!;
    // The annotate call itself never becomes content — only the annotated target persists.
    expect(assistant.content).toEqual([
      { type: 'tool_use', callId: 'c1', name: 'mcp__otto-tools__shell_exec', input: { command: 'iostat' } },
      { type: 'tool_result', callId: 'c1', result: { stdout: 'x\n', exitCode: 0 }, isError: false, takeaway: 'indexer reading 212 MB/s during the hitch' },
    ]);
    const ann = events.find((e) => e.type === 'tool-result-annotated');
    expect(ann).toMatchObject({ callId: 'c1', takeaway: 'indexer reading 212 MB/s during the hitch' });
    expect(events.filter((e) => e.type === 'tool-call-start')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'tool-call-result')).toHaveLength(1);
  });

  it('annotate_result honors call_id and attaches why to the named result', async () => {
    const { openStream } = makeFakeOpenStream(async function* () {
      yield { type: 'tool-call-start', callId: 'c1', name: 'mcp__otto-tools__shell_exec', input: { command: 'frobnicate' } };
      yield { type: 'tool-call-result', callId: 'c1', result: { stdout: '', stderr: 'frobnicate: command not found\n', exitCode: 127 }, isError: false };
      yield { type: 'tool-call-start', callId: 'c2', name: 'mcp__otto-tools__shell_exec', input: { command: 'which frob' } };
      yield { type: 'tool-call-result', callId: 'c2', result: { stdout: '', exitCode: 1 }, isError: false };
      yield { type: 'tool-call-start', callId: 'c3', name: 'mcp__otto-tools__annotate_result', input: { call_id: 'c1', why: "frobnicate isn't installed — trying the flatpak next" } };
      yield { type: 'tool-call-result', callId: 'c3', result: 'noted', isError: false };
      yield { type: 'message-end' };
      yield { type: 'done' };
    });
    fakeSdk.openStream = openStream;
    const { sessionId } = await manager.start({});
    await manager.send({ sessionId, text: 'run frobnicate' });
    const assistant = repo.loadMessages(sessionId).find((m) => m.role === 'assistant')!;
    const results = assistant.content.filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result');
    expect(results).toHaveLength(2);
    expect(results[0]!.why).toBe("frobnicate isn't installed — trying the flatpak next");
    expect(results[1]!.why).toBeUndefined();
  });

  it('folds a structured mark_task_complete into an outcome block with computed stats', async () => {
    const { openStream } = makeFakeOpenStream(async function* () {
      yield { type: 'tool-call-start', callId: 'c1', name: 'mcp__otto-tools__shell_exec', input: { command: 'balooctl suspend' } };
      yield { type: 'tool-call-result', callId: 'c1', result: { stdout: '', exitCode: 0 }, isError: false };
      yield { type: 'tool-call-start', callId: 'c2', name: 'mcp__otto-tools__knowledge_append', input: { note: 'baloo indexing causes frame hitches under load' } };
      yield { type: 'tool-call-result', callId: 'c2', result: 'noted', isError: false };
      yield {
        type: 'tool-call-start', callId: 'c3', name: 'mcp__otto-tools__mark_task_complete',
        input: {
          summary: 'paused the indexer',
          title: 'Stopped the frame hitches',
          cause: 'baloo indexing a fresh 200GB dump',
          fix: 'balooctl suspend',
          verified: '0 spikes over 20ms in a 3m watch',
          undo_command: 'balooctl resume',
        },
      };
      yield { type: 'tool-call-result', callId: 'c3', result: 'noted', isError: false };
      yield { type: 'message-end' };
      yield { type: 'done' };
    });
    fakeSdk.openStream = openStream;
    const { sessionId } = await manager.start({});
    await manager.send({ sessionId, text: 'fix the stutters' });

    const assistant = repo.loadMessages(sessionId).find((m) => m.role === 'assistant')!;
    // The mark call never becomes tool blocks — it becomes the outcome block.
    expect(assistant.content.filter((b) => b.type === 'tool_use').map((b) => (b as { callId: string }).callId)).toEqual(['c1', 'c2']);
    const last = assistant.content[assistant.content.length - 1]!;
    expect(last).toMatchObject({
      type: 'outcome',
      title: 'Stopped the frame hitches',
      summary: 'paused the indexer',
      cause: 'baloo indexing a fresh 200GB dump',
      fix: 'balooctl suspend',
      verified: '0 spikes over 20ms in a 3m watch',
      undoCommand: 'balooctl resume',
      learnedNote: 'baloo indexing causes frame hitches under load',
      toolCalls: 2,
    });
    const oe = events.find((e) => e.type === 'outcome');
    expect(oe).toMatchObject({ sessionId, block: { title: 'Stopped the frame hitches' } });
    expect(events.filter((e) => e.type === 'tool-call-start')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'tool-call-result')).toHaveLength(2);
  });

  it('swallows a summary-only mark_task_complete without emitting an outcome', async () => {
    const { openStream } = makeFakeOpenStream(async function* () {
      yield { type: 'tool-call-start', callId: 'c1', name: 'mcp__otto-tools__shell_exec', input: { command: 'ls' } };
      yield { type: 'tool-call-result', callId: 'c1', result: { stdout: 'a\n', exitCode: 0 }, isError: false };
      yield { type: 'tool-call-start', callId: 'c2', name: 'mcp__otto-tools__mark_task_complete', input: { summary: 'answered the question' } };
      yield { type: 'tool-call-result', callId: 'c2', result: 'noted', isError: false };
      yield { type: 'message-end' };
      yield { type: 'done' };
    });
    fakeSdk.openStream = openStream;
    const { sessionId } = await manager.start({});
    await manager.send({ sessionId, text: 'what files are here' });

    const assistant = repo.loadMessages(sessionId).find((m) => m.role === 'assistant')!;
    expect(assistant.content).toEqual([
      { type: 'tool_use', callId: 'c1', name: 'mcp__otto-tools__shell_exec', input: { command: 'ls' } },
      { type: 'tool_result', callId: 'c1', result: { stdout: 'a\n', exitCode: 0 }, isError: false },
    ]);
    expect(events.find((e) => e.type === 'outcome')).toBeUndefined();
  });

  it('counts user approvals into the outcome and resets the counter afterwards', async () => {
    const markScript = (callId: string, title: string): Script =>
      async function* () {
        yield { type: 'tool-call-start', callId, name: 'mcp__otto-tools__mark_task_complete', input: { summary: 'done', title } };
        yield { type: 'tool-call-result', callId, result: 'noted', isError: false };
        yield { type: 'message-end' };
        yield { type: 'done' };
      };
    const { openStream } = makeFakeOpenStream([markScript('m1', 'Task one'), markScript('m2', 'Task two')]);
    fakeSdk.openStream = openStream;
    const { sessionId } = await manager.start({});

    manager.noteApproval(sessionId);
    manager.noteApproval(sessionId);
    await manager.send({ sessionId, text: 'do the thing' });

    // No approvals between the tasks — the second outcome must not inherit the count.
    await manager.send({ sessionId, text: 'and the other thing' });

    const outcomes = events.filter(
      (e): e is Extract<SessionEvent, { type: 'outcome' }> => e.type === 'outcome'
    );
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]!.block).toMatchObject({ title: 'Task one', approvals: 2 });
    expect(outcomes[1]!.block.title).toBe('Task two');
    expect('approvals' in outcomes[1]!.block).toBe(false);
  });

  it('records reasoning as a thinking block ahead of the answer text and emits reasoning events', async () => {
    const { openStream } = makeFakeOpenStream(async function* () {
      yield { type: 'reasoning', text: 'let me ' };
      yield { type: 'reasoning', text: 'think' };
      yield { type: 'text-delta', text: 'answer' };
      yield { type: 'message-end' };
      yield { type: 'done' };
    });
    fakeSdk.openStream = openStream;
    const { sessionId } = await manager.start({});
    await manager.send({ sessionId, text: 'ponder' });

    const reasoningEvents = events.filter((e) => e.type === 'reasoning');
    expect(reasoningEvents).toHaveLength(2);

    const assistant = repo.loadMessages(sessionId).find((m) => m.role === 'assistant')!;
    expect(assistant.content).toEqual([
      { type: 'thinking', text: 'let me think' },
      { type: 'text', text: 'answer' },
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

  it('starts a private session that is not persisted to history', async () => {
    const { PrivacyAwareRepo } = await import('../db/privacy-aware-repo');
    const privRepo = new PrivacyAwareRepo(openDatabase(path.join(dir, 'priv.db')));
    const { openStream } = makeFakeOpenStream(async function* () {
      yield { type: 'message-end' };
      yield { type: 'done' };
    });
    const privSdk: SdkClient = { startSession: vi.fn(async () => ({ id: 'sdk-priv' })), openStream };
    const mgr = new SessionManager(privRepo, privSdk, 'claude-sonnet-5-5', () => {});
    const { sessionId } = await mgr.start({ private: true });
    expect(privRepo.isPrivate(sessionId)).toBe(true);
    expect(privRepo.listSessions().find((s) => s.id === sessionId)).toBeUndefined();
    expect(privRepo.getSession(sessionId)?.model).toBe('claude-sonnet-5-5');
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

  it('strips inline image blocks that have no matching refs (never retains base64)', async () => {
    const { openStream } = makeFakeOpenStream(async function* () {
      yield { type: 'tool-call-start', callId: 'cs-2', name: 'screenshot', input: {} };
      yield {
        type: 'tool-call-result',
        callId: 'cs-2',
        isError: false,
        result: {
          content: [
            { type: 'image', data: 'ORPHANBASE64', mimeType: 'image/jpeg' },
            { type: 'text', text: '{}' },
          ],
        },
      };
      yield { type: 'message-end' };
      yield { type: 'done' };
    });
    fakeSdk.openStream = openStream;
    // Deliberately no __setScreenshotRefsForTest: simulates a missed ref.
    const { sessionId } = await manager.start({});
    await manager.send({ sessionId, text: 'go' });

    const result = events.find((e) => e.type === 'tool-call-result') as Extract<SessionEvent, { type: 'tool-call-result' }>;
    const content = (result.result as { content: unknown[] }).content;
    expect(JSON.stringify(content)).not.toContain('ORPHANBASE64');
    expect((content[0] as { type: string }).type).toBe('text');
    expect((content[1] as { text: string }).text).toBe('{}');
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
    const mgr = new SessionManager(repo, fakeSdk, 'claude-sonnet-5-5', fanout);
    const { sessionId } = await mgr.start({});
    bus.subscribe(sessionId, (e) => busCalls.push(e));
    await mgr.send({ sessionId, text: 'go' });

    expect(rendererCalls.some((e) => e.type === 'text-delta')).toBe(true);
    expect(busCalls.some((e) => e.type === 'event' && (e as { kind?: string }).kind === 'text-delta')).toBe(true);
  });

  describe('voice suffix', () => {
    it('appends the voice suffix to the SDK-bound text but keeps the UI event text clean', async () => {
      const enqueued: string[] = [];
      const { openStream } = makeFakeOpenStream(async function* ({ text }) {
        enqueued.push(text);
        yield { type: 'text-delta', text: 'sure' };
        yield { type: 'message-end' };
        yield { type: 'done' };
      });
      fakeSdk.openStream = openStream;
      const { sessionId } = await manager.start({});
      await manager.send({ sessionId, text: 'hello', voice: true });

      // The SDK received the text with the voice suffix appended.
      expect(enqueued[0]).toBe('hello' + SessionManager.VOICE_SUFFIX);

      // The user-message event emitted to the renderer contains the clean text only.
      const userMsgEvent = events.find((e) => e.type === 'user-message');
      expect(userMsgEvent).toBeDefined();
      expect((userMsgEvent as { text: string }).text).toBe('hello');

      // The persisted user message also contains the clean text.
      const msgs = repo.loadMessages(sessionId);
      const userMsg = msgs.find((m) => m.role === 'user');
      expect(userMsg?.content).toEqual([{ type: 'text', text: 'hello' }]);
    });

    it('does not append the suffix for non-voice sends', async () => {
      const enqueued: string[] = [];
      const { openStream } = makeFakeOpenStream(async function* ({ text }) {
        enqueued.push(text);
        yield { type: 'text-delta', text: 'ok' };
        yield { type: 'message-end' };
        yield { type: 'done' };
      });
      fakeSdk.openStream = openStream;
      const { sessionId } = await manager.start({});
      await manager.send({ sessionId, text: 'hello' });

      expect(enqueued[0]).toBe('hello');
    });
  });
});

describe('SessionManager origin tracking', () => {
  function gatedManager() {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { openStream } = makeFakeOpenStream(async function* () {
      await gate;
      yield { type: 'text-delta', text: 'ok' };
      yield { type: 'message-end' };
      yield { type: 'done' };
    });
    fakeSdk.openStream = openStream;
    return { release };
  }

  it('reports remote for the session while its remote-origin message is in flight', async () => {
    const { release } = gatedManager();
    const { sessionId } = await manager.start({});
    const p = manager.send({ sessionId, text: 'hi', origin: 'remote' });
    expect(manager.originForSession(sessionId)).toBe('remote');
    expect(manager.hasActiveTurn(sessionId)).toBe(true);
    expect(manager.hasActiveTurn()).toBe(true);
    expect(manager.hasActiveTurn('other')).toBe(false);
    release();
    await p;
    expect(manager.hasActiveTurn(sessionId)).toBe(false);
    // Falls back to the last finalized message's origin.
    expect(manager.originForSession(sessionId)).toBe('remote');
  });

  it('defaults origin to desktop', async () => {
    const { release } = gatedManager();
    const { sessionId } = await manager.start({});
    const p = manager.send({ sessionId, text: 'hi' });
    expect(manager.originForSession(sessionId)).toBe('desktop');
    release();
    await p;
    expect(manager.originForSession(sessionId)).toBe('desktop');
  });

  it('returns desktop for unknown sessions', () => {
    expect(manager.originForSession('nope')).toBe('desktop');
  });

  it('a desktop turn after a finished remote turn keeps the remote origin until it finalizes', async () => {
    const { release } = gatedManager();
    const { sessionId } = await manager.start({});
    release();
    await manager.send({ sessionId, text: 'r', origin: 'remote' });
    const p = manager.send({ sessionId, text: 'd' });
    expect(manager.originForSession(sessionId)).toBe('remote');
    await p;
    expect(manager.originForSession(sessionId)).toBe('desktop');
  });

  it('a send that throws before enqueueing does not leave the session pinned to remote', async () => {
    fakeSdk.openStream = vi.fn(() => { throw new Error('spawn failed'); });
    const { sessionId } = await manager.start({});
    await expect(manager.send({ sessionId, text: 'r', origin: 'remote' })).rejects.toThrow('spawn failed');
    expect(manager.originForSession(sessionId)).toBe('desktop');
    expect(manager.hasActiveTurn(sessionId)).toBe(false);
  });

  it('stays remote after close drops an unfinalized remote message', async () => {
    gatedManager();
    const { sessionId } = await manager.start({});
    void manager.send({ sessionId, text: 'r', origin: 'remote' });
    await manager.close({ sessionId });
    expect(manager.originForSession(sessionId)).toBe('remote');
  });

  it('a tool call in a session with a pending remote turn decides as remote even after other sends move the current message id', async () => {
    gatedManager();
    let currentMessageId = '';
    const m = new SessionManager(repo, fakeSdk, 'claude-sonnet-5-5', (e) => events.push(e), (id) => { currentMessageId = id; });
    (fakeSdk.startSession as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ id: 'sess-B' })
      .mockResolvedValueOnce({ id: 'sess-A' });
    const B = (await m.start({})).sessionId;
    const A = (await m.start({})).sessionId;
    void m.send({ sessionId: B, text: 'remote task', origin: 'remote' });
    void m.send({ sessionId: A, text: 'desktop task' });
    void m.send({ sessionId: B, text: 'queued desktop', origin: 'desktop' });

    const handlers = new Map<string, (args: unknown, extra: unknown) => Promise<unknown>>();
    const sdk = {
      tool: (name: string, _d: string, _s: unknown, h: (args: unknown, extra: unknown) => Promise<unknown>) => { handlers.set(name, h); return { name }; },
      createSdkMcpServer: (o: unknown) => o,
    };
    const decide = vi.fn(async () => 'deny');
    buildOttoMcpServer(sdk as never, {
      broker: { decide } as never,
      sudo: {} as never,
      sessionId: B,
      getMessageId: () => currentMessageId,
      getOrigin: (sid: string) => m.originForSession(sid),
      getRegistry: () => ({}) as never,
      getConfigDir: () => '/tmp',
    } as never);
    await handlers.get('shell_exec')!({ command: 'ls' }, {});
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ sessionId: B, origin: 'remote' }));
  });
});

describe('SessionManager turn labelling with an eagerly-pulling SDK', () => {
  const ids = () => events.filter((e) => e.type === 'message-start').map((e) => (e as { messageId: string }).messageId);
  const ended = () => events.filter((e) => e.type === 'message-end').map((e) => (e as { messageId: string }).messageId);
  const cancelled = () => events.filter((e) => e.type === 'message-cancelled').map((e) => (e as { messageId: string }).messageId);

  function toolHarness(sessionId: string, m: SessionManager, peers?: unknown) {
    const handlers = new Map<string, (args: unknown, extra: unknown) => Promise<unknown>>();
    const sdk = {
      tool: (name: string, _d: string, _s: unknown, h: (args: unknown, extra: unknown) => Promise<unknown>) => { handlers.set(name, h); return { name }; },
      createSdkMcpServer: (o: unknown) => o,
    };
    const decide = vi.fn(async () => 'deny');
    buildOttoMcpServer(sdk as never, {
      broker: { decide } as never,
      sudo: {} as never,
      sessionId,
      getMessageId: () => '',
      getOrigin: (sid: string) => m.originForSession(sid),
      getRegistry: () => ({}) as never,
      getConfigDir: () => '/tmp',
      peers,
    } as never);
    return { handlers, decide };
  }

  it('a remote prompt the running desktop turn never reads gets its own turn and keeps its origin for its tool calls', async () => {
    let releaseD!: () => void;
    const gateD = new Promise<void>((r) => { releaseD = r; });
    let harness: ReturnType<typeof toolHarness> | null = null;
    const toolResults: unknown[] = [];
    const { openStream } = makeEagerOpenStream(async function* ({ text }) {
      if (text === 'desktop task') {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'd-started' }] } };
        await gateD;
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'd-done' }] } };
        return;
      }
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'c1', name: 'mcp__otto-tools__shell_exec', input: { command: 'rm -rf ~/x' } }] } };
      toolResults.push(await harness!.handlers.get('shell_exec')!({ command: 'rm -rf ~/x' }, { toolUseId: 'c1' }));
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'r-done' }] } };
    });
    fakeSdk.openStream = openStream;
    const { sessionId } = await manager.start({});
    harness = toolHarness(sessionId, manager);

    const pD = manager.send({ sessionId, text: 'desktop task' });
    await waitFor(() => events.some((e) => e.type === 'text-delta' && (e as { text: string }).text === 'd-started'));
    const pR = manager.send({ sessionId, text: 'remote task', origin: 'remote' });
    await new Promise((r) => setTimeout(r, 5));
    releaseD();
    await waitFor(() => harness!.decide.mock.calls.length > 0);
    expect(harness.decide).toHaveBeenCalledWith(expect.objectContaining({ sessionId, origin: 'remote' }));

    await Promise.all([pD, pR]);
    const [D, R] = ids();
    expect(ended()).toEqual([D, R]);
    const assistants = repo.loadMessages(sessionId).filter((msg) => msg.role === 'assistant');
    expect(assistants.map((a) => a.id)).toEqual([D, R]);
    expect(assistants[0]!.content).toEqual([{ type: 'text', text: 'd-startedd-done' }]);
    expect(assistants[1]!.content.some((b) => b.type === 'tool_use' && b.callId === 'c1')).toBe(true);
    expect(manager.originForSession(sessionId)).toBe('remote');
  });

  it('refuses onward delegation in a remote prompt promoted behind a running desktop turn', async () => {
    let releaseD!: () => void;
    const gateD = new Promise<void>((r) => { releaseD = r; });
    let harness: ReturnType<typeof toolHarness> | null = null;
    const run = vi.fn(async () => 'ran');
    const wait = vi.fn(async () => 'waited');
    const outs: Array<{ isError?: boolean; content: Array<{ text: string }> }> = [];
    const { openStream } = makeEagerOpenStream(async function* ({ text }) {
      if (text === 'desktop task') {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'd-started' }] } };
        await gateD;
        return;
      }
      for (const name of ['delegate_to_machine', 'wait_for_machine']) {
        outs.push(await harness!.handlers.get(name)!({ machine: 'Desk', task: 'do it' }, {}) as typeof outs[number]);
      }
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'r-done' }] } };
    });
    fakeSdk.openStream = openStream;
    const { sessionId } = await manager.start({});
    harness = toolHarness(sessionId, manager, { machineNames: () => ['Desk'], run, wait });

    const pD = manager.send({ sessionId, text: 'desktop task' });
    await waitFor(() => events.some((e) => e.type === 'text-delta'));
    const pR = manager.send({ sessionId, text: 'remote task', origin: 'remote' });
    await new Promise((r) => setTimeout(r, 5));
    releaseD();
    await waitFor(() => outs.length === 2);
    for (const out of outs) {
      expect(out.isError).toBe(true);
      expect(out.content[0]!.text).toBe("Delegation isn't available for tasks that came from another machine.");
    }
    expect(run).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
    await Promise.all([pD, pR]);
  });

  it('an interrupt with an unread steer cancels only the running turn and the steer finalizes as its own', async () => {
    const { openStream } = makeEagerOpenStream(async function* ({ text, signal }) {
      if (text === 'desktop task') {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'd-part' }] } };
        if (!signal.aborted) await new Promise<void>((r) => signal.addEventListener('abort', () => r()));
        return;
      }
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'r-text' }] } };
    });
    fakeSdk.openStream = openStream;
    const { sessionId } = await manager.start({});
    const pD = manager.send({ sessionId, text: 'desktop task' });
    await waitFor(() => events.some((e) => e.type === 'text-delta'));
    const pR = manager.send({ sessionId, text: 'remote task', origin: 'remote' });
    await new Promise((r) => setTimeout(r, 5));
    await manager.interrupt({ sessionId });
    await Promise.all([pD, pR]);

    const [D, R] = ids();
    expect(cancelled()).toEqual([D]);
    expect(ended()).toEqual([R]);
    const assistants = repo.loadMessages(sessionId).filter((msg) => msg.role === 'assistant');
    const d = assistants.find((a) => a.id === D)!;
    const r = assistants.find((a) => a.id === R)!;
    expect(d.content).toEqual([{ type: 'text', text: 'd-part' }]);
    expect('cancelled' in d && d.cancelled).toBe(true);
    expect(r.content).toEqual([{ type: 'text', text: 'r-text' }]);
    expect('cancelled' in r && r.cancelled).toBeFalsy();
    expect(manager.originForSession(sessionId)).toBe('remote');
  });

  it('folds a message sent mid-turn into the running turn as a user_note', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { openStream, pulled } = makeEagerOpenStream(async function* ({ drain }) {
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'c1', name: 'probe', input: {} }] } };
      await gate;
      yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] } };
      yield* drain();
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'adjusted' }] } };
    });
    fakeSdk.openStream = openStream;
    const { sessionId } = await manager.start({});
    const pD = manager.send({ sessionId, text: 'fix the stutter' });
    await waitFor(() => events.some((e) => e.type === 'tool-call-start'));
    let steerSettled = false;
    const pN = manager.send({ sessionId, text: 'only with Discord open', origin: 'remote' }).then(() => { steerSettled = true; });
    await new Promise((r) => setTimeout(r, 5));
    // Handed to the SDK straight away, not held for the turn to end.
    expect(pulled).toEqual(['fix the stutter', 'only with Discord open']);
    const [D] = ids();
    const queued = events.find((e) => e.type === 'steer-queued') as Extract<SessionEvent, { type: 'steer-queued' }>;
    expect(queued).toMatchObject({ messageId: D, text: 'only with Discord open' });
    release();
    await pN;
    expect(steerSettled).toBe(true);
    await pD;

    expect(ids()).toEqual([D]);
    expect(ended()).toEqual([D]);
    expect(events).toContainEqual({ type: 'steer-folded', sessionId, messageId: D, noteId: queued.noteId });
    expect(events.some((e) => e.type === 'user-message' && e.text === 'only with Discord open')).toBe(false);
    const msgs = repo.loadMessages(sessionId);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[1]!.content.map((b) => b.type)).toEqual(['tool_use', 'tool_result', 'user_note', 'text']);
    expect(msgs[1]!.content[2]).toEqual({
      type: 'user_note',
      id: queued.noteId,
      text: 'only with Discord open',
      content: [{ type: 'text', text: 'only with Discord open' }],
    });
    // A folded note borrows the running turn's origin; it leaves none behind.
    expect(manager.originForSession(sessionId)).toBe('desktop');
  });

  it('a steer promoted to its own turn is persisted as a user message after the earlier turn', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { openStream } = makeEagerOpenStream(async function* ({ text }) {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: `re:${text}` }] } };
      if (text === 'first') await gate;
    });
    fakeSdk.openStream = openStream;
    const { sessionId } = await manager.start({});
    const p1 = manager.send({ sessionId, text: 'first' });
    await waitFor(() => events.some((e) => e.type === 'text-delta'));
    const p2 = manager.send({ sessionId, text: 'second' });
    await new Promise((r) => setTimeout(r, 5));
    release();
    await Promise.all([p1, p2]);
    const queued = events.find((e) => e.type === 'steer-queued') as Extract<SessionEvent, { type: 'steer-queued' }>;
    const promotedAt = events.findIndex((e) => e.type === 'steer-promoted');
    expect(events[promotedAt]).toEqual({ type: 'steer-promoted', sessionId, noteId: queued.noteId });
    expect(events[promotedAt + 1]).toMatchObject({ type: 'user-message', messageId: queued.noteId, text: 'second' });
    const msgs = repo.loadMessages(sessionId);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(msgs[2]!.id).toBe(queued.noteId);
    expect(msgs[3]!.content).toEqual([{ type: 'text', text: 're:second' }]);
  });
});
