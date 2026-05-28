import type { Repo } from '../db/repo';
import type { Embedder } from '../embeddings/embedder';
import type { ContentBlock, Message } from '@shared/messages';
import { CONTEXT_WINDOW_CHARS, SIMILARITY_THRESHOLD } from '@shared/topic-shift-constants';
import { logger } from '../logger';

export interface TopicShiftDetectorDeps {
  repo: Pick<Repo, 'loadMessages'>;
  embedder: Pick<Embedder, 'embedBatch' | 'isAvailable'>;
}

export interface EvaluateResult {
  suggest: boolean;
  similarity: number;
}

export class TopicShiftDetector {
  constructor(private readonly deps: TopicShiftDetectorDeps) {}

  buildContextWindow(sessionId: string): string {
    const messages = this.deps.repo.loadMessages(sessionId);
    if (messages.length === 0) return '';
    const collected: string[] = [];
    let total = 0;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]!;
      const line = renderMessageLine(m);
      if (line === null) continue;
      collected.push(line);
      total += line.length + 1; // +1 for the joining newline
      if (total >= CONTEXT_WINDOW_CHARS) break;
    }
    collected.reverse();
    return collected.join('\n');
  }

  async evaluate(sessionId: string, newPrompt: string): Promise<EvaluateResult> {
    if (!this.deps.embedder.isAvailable) {
      return { suggest: false, similarity: NaN };
    }
    const context = this.buildContextWindow(sessionId);
    if (context.length === 0) {
      return { suggest: false, similarity: NaN };
    }
    try {
      const [ctxVec, promptVec] = await this.deps.embedder.embedBatch([context, newPrompt]);
      if (!ctxVec || !promptVec) {
        return { suggest: false, similarity: NaN };
      }
      const sim = cosineSimilarity(ctxVec, promptVec);
      return { suggest: sim < SIMILARITY_THRESHOLD, similarity: sim };
    } catch (err) {
      logger.warn(`topic-shift evaluate failed: ${err instanceof Error ? err.message : err}`);
      return { suggest: false, similarity: NaN };
    }
  }
}

function renderMessageLine(m: Message): string | null {
  if (m.role !== 'user' && m.role !== 'assistant') return null;
  const text = extractText(m.content);
  if (text.length === 0) return null;
  return `${m.role}: ${text}`;
}

function extractText(content: ContentBlock[]): string {
  let s = '';
  for (const block of content) {
    if (block.type === 'text') s += block.text;
  }
  return s;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return NaN;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return NaN;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
