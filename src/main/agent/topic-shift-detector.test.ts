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

describe('TopicShiftDetector.evaluate', () => {
  function makeEmbedder(map: Map<string, number[]>, isAvailable = true) {
    return {
      isAvailable,
      async embedBatch(texts: string[]) {
        return texts.map((t) => {
          const vec = map.get(t);
          if (!vec) throw new Error(`fake embedder: no vector for ${JSON.stringify(t)}`);
          return new Float32Array(vec);
        });
      },
    };
  }

  function fakeRepoWith(messages: Message[]) {
    return { loadMessages: (_id: string) => messages };
  }

  const ALIGNED = [1, 0, 0]; // cosine to itself = 1.0
  const ORTHOGONAL = [0, 1, 0]; // cosine vs ALIGNED = 0.0

  it('returns suggest=false and NaN similarity when embedder is unavailable', async () => {
    const d = new TopicShiftDetector({
      repo: fakeRepoWith([userMsg('hello', 0)]),
      embedder: makeEmbedder(new Map(), false),
    });
    const result = await d.evaluate('s1', 'new prompt');
    expect(result.suggest).toBe(false);
    expect(Number.isNaN(result.similarity)).toBe(true);
  });

  it('returns suggest=false when context window is empty (fresh session)', async () => {
    const d = new TopicShiftDetector({
      repo: fakeRepoWith([]),
      embedder: makeEmbedder(new Map()),
    });
    const result = await d.evaluate('s1', 'anything');
    expect(result.suggest).toBe(false);
  });

  it('returns suggest=true when similarity is clearly below threshold', async () => {
    const messages = [userMsg('about cooking', 0)];
    const map = new Map<string, number[]>([
      ['user: about cooking', ALIGNED],
      ['rocket science', ORTHOGONAL],
    ]);
    const d = new TopicShiftDetector({
      repo: fakeRepoWith(messages),
      embedder: makeEmbedder(map),
    });
    const result = await d.evaluate('s1', 'rocket science');
    expect(result.suggest).toBe(true);
    expect(result.similarity).toBeCloseTo(0.0, 5);
  });

  it('returns suggest=false when similarity is above threshold', async () => {
    const messages = [userMsg('about cooking', 0)];
    // cosine([1,0,0], [0.5, sqrt(0.75), 0]) = 0.5
    const SIMILAR = [0.5, Math.sqrt(0.75), 0];
    const map = new Map<string, number[]>([
      ['user: about cooking', ALIGNED],
      ['more about food', SIMILAR],
    ]);
    const d = new TopicShiftDetector({
      repo: fakeRepoWith(messages),
      embedder: makeEmbedder(map),
    });
    const result = await d.evaluate('s1', 'more about food');
    expect(result.suggest).toBe(false);
    expect(result.similarity).toBeCloseTo(0.5, 5);
  });

  it('treats similarity exactly at threshold as not-a-shift (strict less-than)', async () => {
    const messages = [userMsg('about cooking', 0)];
    // Use a value slightly above 0.35 to account for Float32Array precision loss:
    // Float32Array([0.35, ...]) rounds 0.35 down to ~0.34999999, giving cosine < 0.35.
    // 0.35001 survives float32 rounding at or above the threshold.
    const AT_THRESHOLD = [0.35001, Math.sqrt(1 - 0.35001 * 0.35001), 0];
    const map = new Map<string, number[]>([
      ['user: about cooking', ALIGNED],
      ['edge case', AT_THRESHOLD],
    ]);
    const d = new TopicShiftDetector({
      repo: fakeRepoWith(messages),
      embedder: makeEmbedder(map),
    });
    const result = await d.evaluate('s1', 'edge case');
    expect(result.similarity).toBeGreaterThanOrEqual(0.35);
    expect(result.suggest).toBe(false);
  });

  it('returns suggest=false when embedder throws', async () => {
    const messages = [userMsg('about cooking', 0)];
    const throwingEmbedder = {
      isAvailable: true,
      async embedBatch() {
        throw new Error('inference exploded');
      },
    };
    const d = new TopicShiftDetector({
      repo: fakeRepoWith(messages),
      embedder: throwingEmbedder,
    });
    const result = await d.evaluate('s1', 'anything');
    expect(result.suggest).toBe(false);
    expect(Number.isNaN(result.similarity)).toBe(true);
  });
});
