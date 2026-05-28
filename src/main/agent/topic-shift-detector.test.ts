import { describe, expect, it } from 'vitest';
import type { Message, UserMessage, AssistantMessage } from '@shared/messages';
import { TopicShiftDetector } from './topic-shift-detector';

function userMsg(text: string, seq: number): UserMessage {
  return {
    id: `u${seq}`,
    sessionId: 's1',
    seq,
    createdAt: 0,
    role: 'user',
    content: [{ type: 'text', text }],
  };
}

function assistantMsg(text: string, seq: number): AssistantMessage {
  return {
    id: `a${seq}`,
    sessionId: 's1',
    seq,
    createdAt: 0,
    role: 'assistant',
    content: [{ type: 'text', text }],
    cancelled: false,
    errored: false,
  };
}

function fakeRepo(messages: Message[]) {
  return { loadMessages: (_sessionId: string) => messages };
}

const noopEmbedder = {
  isAvailable: true,
  async embedBatch(texts: string[]) {
    return texts.map(() => new Float32Array(384));
  },
};

describe('TopicShiftDetector.buildContextWindow', () => {
  it('returns empty string for empty session', () => {
    const d = new TopicShiftDetector({ repo: fakeRepo([]), embedder: noopEmbedder });
    expect(d.buildContextWindow('s1')).toBe('');
  });

  it('returns role-prefixed single user message for a one-message session', () => {
    const d = new TopicShiftDetector({
      repo: fakeRepo([userMsg('hello', 0)]),
      embedder: noopEmbedder,
    });
    expect(d.buildContextWindow('s1')).toBe('user: hello');
  });

  it('joins multiple alternating messages chronologically with role prefixes', () => {
    const d = new TopicShiftDetector({
      repo: fakeRepo([
        userMsg('hi', 0),
        assistantMsg('hey', 1),
        userMsg('how are you', 2),
        assistantMsg('good', 3),
      ]),
      embedder: noopEmbedder,
    });
    expect(d.buildContextWindow('s1')).toBe(
      'user: hi\nassistant: hey\nuser: how are you\nassistant: good',
    );
  });

  it('stops at the next message boundary once the budget is crossed', () => {
    const long = 'x'.repeat(500);
    const d = new TopicShiftDetector({
      repo: fakeRepo([
        userMsg(long, 0),
        assistantMsg(long, 1),
        userMsg(long, 2),
        assistantMsg(long, 3),
        userMsg(long, 4),
      ]),
      embedder: noopEmbedder,
    });
    const window = d.buildContextWindow('s1');
    const includedLines = window.split('\n');
    expect(includedLines.length).toBeGreaterThanOrEqual(1);
    for (const line of includedLines) {
      expect(line.startsWith('user: ') || line.startsWith('assistant: ')).toBe(true);
    }
    // Each line is ~507 chars (prefix + 500 x's). Four such lines = 2028 chars
    // > 2000 budget. So expect ~4 included; never more.
    expect(includedLines.length).toBeLessThanOrEqual(5);
  });

  it('includes a single oversized message rather than slicing it', () => {
    const huge = 'a'.repeat(5000);
    const d = new TopicShiftDetector({
      repo: fakeRepo([userMsg(huge, 0)]),
      embedder: noopEmbedder,
    });
    expect(d.buildContextWindow('s1')).toBe(`user: ${huge}`);
  });

  it('skips messages with no text content (tool-only assistant messages)', () => {
    const toolOnlyAssistant: AssistantMessage = {
      id: 'a0',
      sessionId: 's1',
      seq: 0,
      createdAt: 0,
      role: 'assistant',
      content: [{ type: 'tool_use', callId: 'c1', name: 'shell', input: {} }],
      cancelled: false,
      errored: false,
    };
    const d = new TopicShiftDetector({
      repo: fakeRepo([toolOnlyAssistant, userMsg('hello', 1)]),
      embedder: noopEmbedder,
    });
    expect(d.buildContextWindow('s1')).toBe('user: hello');
  });

  it('concatenates multiple text blocks within a single message', () => {
    const u: UserMessage = {
      id: 'u0',
      sessionId: 's1',
      seq: 0,
      createdAt: 0,
      role: 'user',
      content: [
        { type: 'text', text: 'part one' },
        { type: 'text', text: ' part two' },
      ],
    };
    const d = new TopicShiftDetector({ repo: fakeRepo([u]), embedder: noopEmbedder });
    expect(d.buildContextWindow('s1')).toBe('user: part one part two');
  });
});
