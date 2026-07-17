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

  it('returns suggest=true when similarity is clearly below threshold and no confirmer is configured', async () => {
    const messages = [userMsg('about cooking', 0)];
    const map = new Map<string, number[]>([
      ['user: about cooking', ALIGNED],
      ['tell me about rocket science', ORTHOGONAL],
    ]);
    const d = new TopicShiftDetector({
      repo: fakeRepoWith(messages),
      embedder: makeEmbedder(map),
    });
    const result = await d.evaluate('s1', 'tell me about rocket science');
    expect(result.suggest).toBe(true);
    expect(result.similarity).toBeCloseTo(0.0, 5);
  });

  it('returns suggest=false when similarity is above threshold', async () => {
    const messages = [userMsg('about cooking', 0)];
    // cosine([1,0,0], [0.5, sqrt(0.75), 0]) = 0.5
    const SIMILAR = [0.5, Math.sqrt(0.75), 0];
    const map = new Map<string, number[]>([
      ['user: about cooking', ALIGNED],
      ['tell me more about food', SIMILAR],
    ]);
    const d = new TopicShiftDetector({
      repo: fakeRepoWith(messages),
      embedder: makeEmbedder(map),
    });
    const result = await d.evaluate('s1', 'tell me more about food');
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
      ['this is an edge case', AT_THRESHOLD],
    ]);
    const d = new TopicShiftDetector({
      repo: fakeRepoWith(messages),
      embedder: makeEmbedder(map),
    });
    const result = await d.evaluate('s1', 'this is an edge case');
    expect(result.similarity).toBeGreaterThanOrEqual(0.35);
    expect(result.suggest).toBe(false);
  });

  it('returns suggest=false when embedder throws', async () => {
    const messages = [userMsg('about cooking', 0)];
    const throwingEmbedder = {
      isAvailable: true,
      async embedBatch(): Promise<Float32Array[]> {
        throw new Error('inference exploded');
      },
    };
    const d = new TopicShiftDetector({
      repo: fakeRepoWith(messages),
      embedder: throwingEmbedder,
    });
    const result = await d.evaluate('s1', 'four whole words here');
    expect(result.suggest).toBe(false);
    expect(Number.isNaN(result.similarity)).toBe(true);
  });

  it('returns suggest=false for prompts under the min word count without consulting the embedder', async () => {
    const throwingEmbedder = {
      isAvailable: true,
      async embedBatch(): Promise<Float32Array[]> {
        throw new Error('embedder must not be called for short prompts');
      },
    };
    const d = new TopicShiftDetector({
      repo: fakeRepoWith([userMsg('about cooking', 0)]),
      embedder: throwingEmbedder,
    });
    for (const prompt of ['A', 'yes', 'yeah do it', '  do   it  ']) {
      const result = await d.evaluate('s1', prompt);
      expect(result.suggest).toBe(false);
      expect(Number.isNaN(result.similarity)).toBe(true);
    }
  });
});

describe('TopicShiftDetector.evaluate with LLM confirmer', () => {
  function makeEmbedder(map: Map<string, number[]>) {
    return {
      isAvailable: true,
      async embedBatch(texts: string[]) {
        return texts.map((t) => {
          const vec = map.get(t);
          if (!vec) throw new Error(`fake embedder: no vector for ${JSON.stringify(t)}`);
          return new Float32Array(vec);
        });
      },
    };
  }

  const ALIGNED = [1, 0, 0];
  const ORTHOGONAL = [0, 1, 0];
  const PROMPT = 'tell me about rocket science';

  function lowSimDeps(confirmer: { run(prompt: string, opts: { signal: AbortSignal }): Promise<string> }, confirmTimeoutMs?: number) {
    const map = new Map<string, number[]>([
      ['user: about cooking', ALIGNED],
      [PROMPT, ORTHOGONAL],
    ]);
    return {
      repo: { loadMessages: () => [userMsg('about cooking', 0)] },
      embedder: makeEmbedder(map),
      confirmer,
      confirmTimeoutMs,
    };
  }

  it('suggests only when the confirmer answers newTopic=true', async () => {
    const seen: string[] = [];
    const d = new TopicShiftDetector(
      lowSimDeps({
        async run(prompt) {
          seen.push(prompt);
          return '{"newTopic": true}';
        },
      }),
    );
    const result = await d.evaluate('s1', PROMPT);
    expect(result.suggest).toBe(true);
    expect(result.similarity).toBeCloseTo(0.0, 5);
    // The confirmer prompt must carry both the context and the new message.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('about cooking');
    expect(seen[0]).toContain(PROMPT);
  });

  it('does not suggest when the confirmer answers newTopic=false', async () => {
    const d = new TopicShiftDetector(
      lowSimDeps({
        async run() {
          return 'Sure! Here is the JSON you asked for: {"newTopic": false}';
        },
      }),
    );
    const result = await d.evaluate('s1', PROMPT);
    expect(result.suggest).toBe(false);
  });

  it('does not suggest when the confirmer throws', async () => {
    const d = new TopicShiftDetector(
      lowSimDeps({
        async run(): Promise<string> {
          throw new Error('sdk exploded');
        },
      }),
    );
    const result = await d.evaluate('s1', PROMPT);
    expect(result.suggest).toBe(false);
  });

  it('does not suggest when the confirmer returns non-JSON garbage', async () => {
    const d = new TopicShiftDetector(
      lowSimDeps({
        async run() {
          return 'I think this is probably a new topic, yes.';
        },
      }),
    );
    const result = await d.evaluate('s1', PROMPT);
    expect(result.suggest).toBe(false);
  });

  it('does not suggest and aborts when the confirmer exceeds the timeout', async () => {
    let aborted = false;
    const d = new TopicShiftDetector(
      lowSimDeps(
        {
          run(_prompt, { signal }) {
            return new Promise<string>((_resolve, reject) => {
              signal.addEventListener('abort', () => {
                aborted = true;
                reject(new Error('aborted'));
              });
            });
          },
        },
        10,
      ),
    );
    const result = await d.evaluate('s1', PROMPT);
    expect(result.suggest).toBe(false);
    expect(aborted).toBe(true);
  });

  it('does not consult the confirmer when similarity is above threshold', async () => {
    const SIMILAR = [0.5, Math.sqrt(0.75), 0];
    const map = new Map<string, number[]>([
      ['user: about cooking', ALIGNED],
      ['tell me more about food', SIMILAR],
    ]);
    let called = false;
    const d = new TopicShiftDetector({
      repo: { loadMessages: () => [userMsg('about cooking', 0)] },
      embedder: makeEmbedder(map),
      confirmer: {
        async run() {
          called = true;
          return '{"newTopic": true}';
        },
      },
    });
    const result = await d.evaluate('s1', 'tell me more about food');
    expect(result.suggest).toBe(false);
    expect(called).toBe(false);
  });
});

describe('TopicShiftDetector.evaluate sensitivity', () => {
  function makeEmbedder(map: Map<string, number[]>) {
    return {
      isAvailable: true,
      async embedBatch(texts: string[]) {
        return texts.map((t) => {
          const vec = map.get(t);
          if (!vec) throw new Error(`fake embedder: no vector for ${JSON.stringify(t)}`);
          return new Float32Array(vec);
        });
      },
    };
  }
  const ALIGNED = [1, 0, 0];
  // cosine([1,0,0], [c, sqrt(1-c^2), 0]) === c
  const atSim = (c: number) => [c, Math.sqrt(1 - c * c), 0];
  const PROMPT = 'tell me about rocket science stuff';

  function depsWithSim(sim: number, sensitivity: string, extra: Record<string, unknown> = {}) {
    const map = new Map<string, number[]>([
      ['user: about cooking', ALIGNED],
      [PROMPT, atSim(sim)],
    ]);
    return {
      repo: { loadMessages: () => [userMsg('about cooking', 0)] },
      embedder: makeEmbedder(map),
      getSensitivity: () => sensitivity as never,
      ...extra,
    };
  }

  it('off never consults the embedder and never suggests', async () => {
    const throwing = {
      isAvailable: true,
      async embedBatch(): Promise<Float32Array[]> {
        throw new Error('embedder must not be called when sensitivity is off');
      },
    };
    const d = new TopicShiftDetector({
      repo: { loadMessages: () => [userMsg('about cooking', 0)] },
      embedder: throwing,
      getSensitivity: () => 'off' as never,
    });
    const result = await d.evaluate('s1', PROMPT);
    expect(result.suggest).toBe(false);
  });

  it('high flags a mid-similarity prompt (0.40) that medium would not', async () => {
    // No confirmer → suggest mirrors the embedding flag.
    const high = new TopicShiftDetector(depsWithSim(0.4, 'high'));
    expect((await high.evaluate('s1', PROMPT)).suggest).toBe(true);

    const medium = new TopicShiftDetector(depsWithSim(0.4, 'medium'));
    expect((await medium.evaluate('s1', PROMPT)).suggest).toBe(false);
  });

  it('low does NOT flag a prompt (0.30) that medium would', async () => {
    const low = new TopicShiftDetector(depsWithSim(0.3, 'low'));
    expect((await low.evaluate('s1', PROMPT)).suggest).toBe(false);

    const medium = new TopicShiftDetector(depsWithSim(0.3, 'medium'));
    expect((await medium.evaluate('s1', PROMPT)).suggest).toBe(true);
  });

  it('low requires at least 6 words; a 5-word prompt bypasses the embedder', async () => {
    const throwing = {
      isAvailable: true,
      async embedBatch(): Promise<Float32Array[]> {
        throw new Error('short prompt must bypass the embedder');
      },
    };
    const d = new TopicShiftDetector({
      repo: { loadMessages: () => [userMsg('about cooking', 0)] },
      embedder: throwing,
      getSensitivity: () => 'low' as never,
    });
    const result = await d.evaluate('s1', 'one two three four five');
    expect(result.suggest).toBe(false);
  });

  it('low biases the confirmer prompt toward conservative; medium does not', async () => {
    const lowSeen: string[] = [];
    const low = new TopicShiftDetector(
      depsWithSim(0.2, 'low', {
        confirmer: {
          async run(prompt: string) {
            lowSeen.push(prompt);
            return '{"newTopic": false}';
          },
        },
      }),
    );
    await low.evaluate('s1', PROMPT);
    expect(lowSeen[0]).toMatch(/only.*clearly (unrelated|different)/i);

    const medSeen: string[] = [];
    const medium = new TopicShiftDetector(
      depsWithSim(0.2, 'medium', {
        confirmer: {
          async run(prompt: string) {
            medSeen.push(prompt);
            return '{"newTopic": false}';
          },
        },
      }),
    );
    await medium.evaluate('s1', PROMPT);
    expect(medSeen[0]).not.toMatch(/only.*clearly (unrelated|different)/i);
  });

  it('defaults to medium behavior when no getSensitivity is provided', async () => {
    // 0.30 < 0.35 (medium) → flagged; no confirmer → suggest true.
    const map = new Map<string, number[]>([
      ['user: about cooking', ALIGNED],
      [PROMPT, atSim(0.3)],
    ]);
    const d = new TopicShiftDetector({
      repo: { loadMessages: () => [userMsg('about cooking', 0)] },
      embedder: makeEmbedder(map),
    });
    expect((await d.evaluate('s1', PROMPT)).suggest).toBe(true);
  });
});
