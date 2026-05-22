import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../db/db';
import { Repo } from '../db/repo';
import { SessionManager, type SdkClient, type SdkStreamEvent, type SdkTurn } from './session';
import type { SessionEvent } from '@shared/ipc-contract';

let dir: string;
let repo: Repo;
let manager: SessionManager;
let events: SessionEvent[];
let sdkTurn: SdkTurn | null;
let fakeSdk: SdkClient;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'otto-sess-'));
  const db = openDatabase(path.join(dir, 'otto.db'));
  repo = new Repo(db);
  events = [];
  sdkTurn = null;
  fakeSdk = {
    startSession: vi.fn(async () => ({ id: 'sdk-1' })),
    sendTurn: vi.fn((_sid, _text, signal) => {
      const t: SdkTurn = {
        async *events() {
          yield { type: 'message-start' };
          yield { type: 'text-delta', text: 'hel' };
          yield { type: 'text-delta', text: 'lo' };
          yield { type: 'message-end' };
          yield { type: 'done' };
        },
        signal,
      };
      sdkTurn = t;
      return t;
    }),
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
    fakeSdk.sendTurn = vi.fn((_sid, _text, signal): SdkTurn => ({
      signal,
      async *events(): AsyncGenerator<SdkStreamEvent> {
        yield { type: 'message-start' };
        yield { type: 'tool-call-start', callId: 'c1', name: 'echo', input: { msg: 'hi' } };
        yield { type: 'tool-call-result', callId: 'c1', result: 'hi', isError: false };
        yield { type: 'message-end' };
        yield { type: 'done' };
      },
    }));
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
    fakeSdk.sendTurn = vi.fn((_sid, _text, signal): SdkTurn => ({
      signal,
      async *events(): AsyncGenerator<SdkStreamEvent> {
        yield { type: 'message-start' };
        yield { type: 'text-delta', text: 'partial' };
        throw new Error('boom');
      },
    }));
    const { sessionId } = await manager.start({});
    await manager.send({ sessionId, text: 'fail' });
    const err = events.find((e) => e.type === 'error');
    expect(err).toBeTruthy();
    const assistant = repo.loadMessages(sessionId).find((m) => m.role === 'assistant');
    expect(assistant && 'errored' in assistant && assistant.errored).toBe(true);
  });

  it('cancellation aborts the in-flight turn and marks the message cancelled', async () => {
    fakeSdk.sendTurn = vi.fn((_sid, _text, signal): SdkTurn => ({
      signal,
      async *events(): AsyncGenerator<SdkStreamEvent> {
        yield { type: 'message-start' };
        yield { type: 'text-delta', text: 'part' };
        await new Promise((r) => setTimeout(r, 10));
        if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        yield { type: 'text-delta', text: 'ial' };
        yield { type: 'message-end' };
        yield { type: 'done' };
      },
    }));
    const { sessionId } = await manager.start({});
    const p = manager.send({ sessionId, text: 'long' });
    setTimeout(() => manager.cancel({ sessionId }), 1);
    await p;
    const assistant = repo.loadMessages(sessionId).find((m) => m.role === 'assistant');
    expect(assistant && 'cancelled' in assistant && assistant.cancelled).toBe(true);
  });

  it('persists the sdk session id when received, and passes it as resume on the next turn', async () => {
    const sendTurnSpy = vi.fn((_sid: string, _text: string, signal: AbortSignal, _resumeId?: string): SdkTurn => ({
      signal,
      async *events(): AsyncGenerator<SdkStreamEvent> {
        yield { type: 'message-start' };
        yield { type: 'session-id', id: 'sdk-1' };
        yield { type: 'text-delta', text: 'ok' };
        yield { type: 'message-end' };
        yield { type: 'done' };
      },
    }));
    fakeSdk.sendTurn = sendTurnSpy;
    const { sessionId } = await manager.start({});
    await manager.send({ sessionId, text: 'first' });
    expect(repo.getSession(sessionId)?.sdkSessionId).toBe('sdk-1');
    expect(sendTurnSpy.mock.calls[0]![3]).toBeUndefined();
    await manager.send({ sessionId, text: 'second' });
    expect(sendTurnSpy.mock.calls[1]![3]).toBe('sdk-1');
  });

  it('sets session title from the first user message', async () => {
    const { sessionId } = await manager.start({});
    await manager.send({ sessionId, text: 'first prompt here' });
    expect(repo.getSession(sessionId)?.title).toBe('first prompt here');
  });
});
