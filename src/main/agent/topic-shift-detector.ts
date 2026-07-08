import type { Repo } from '../db/repo';
import type { Embedder } from '../embeddings/embedder';
import type { ContentBlock, Message } from '@shared/messages';
import {
  CONTEXT_WINDOW_CHARS,
  MIN_PROMPT_WORDS,
  SIMILARITY_THRESHOLD,
  TOPIC_SHIFT_CONFIRM_TIMEOUT_MS,
} from '@shared/topic-shift-constants';
import { extractFirstJsonObject } from '../reflection/reflector';
import { logger } from '../logger';

export interface TopicShiftConfirmer {
  run(prompt: string, opts: { signal: AbortSignal }): Promise<string>;
}

export interface TopicShiftDetectorDeps {
  repo: Pick<Repo, 'loadMessages'>;
  embedder: Pick<Embedder, 'embedBatch' | 'isAvailable'>;
  /**
   * Optional LLM yes/no check consulted after the embedding prefilter flags a
   * potential shift. Embedding similarity alone cannot separate real topic
   * shifts from casual follow-ups (measured distributions overlap fully), so
   * when a confirmer is configured the popup only fires on its say-so.
   */
  confirmer?: TopicShiftConfirmer;
  confirmTimeoutMs?: number;
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
    if (newPrompt.trim().split(/\s+/).filter(Boolean).length < MIN_PROMPT_WORDS) {
      return { suggest: false, similarity: NaN };
    }
    const context = this.buildContextWindow(sessionId);
    if (context.length === 0) {
      return { suggest: false, similarity: NaN };
    }
    let sim: number;
    try {
      const [ctxVec, promptVec] = await this.deps.embedder.embedBatch([context, newPrompt]);
      if (!ctxVec || !promptVec) {
        return { suggest: false, similarity: NaN };
      }
      sim = cosineSimilarity(ctxVec, promptVec);
    } catch (err) {
      logger.warn(`topic-shift evaluate failed: ${err instanceof Error ? err.message : err}`);
      return { suggest: false, similarity: NaN };
    }
    if (!(sim < SIMILARITY_THRESHOLD)) {
      return { suggest: false, similarity: sim };
    }
    if (!this.deps.confirmer) {
      return { suggest: true, similarity: sim };
    }
    const confirmed = await this.confirmShift(context, newPrompt);
    return { suggest: confirmed, similarity: sim };
  }

  private async confirmShift(context: string, newPrompt: string): Promise<boolean> {
    const timeoutMs = this.deps.confirmTimeoutMs ?? TOPIC_SHIFT_CONFIRM_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const raw = await this.deps.confirmer!.run(confirmerPrompt(context, newPrompt), {
        signal: controller.signal,
      });
      const parsed = extractFirstJsonObject(raw);
      if (parsed === null || typeof parsed !== 'object' || !('newTopic' in parsed)) {
        logger.warn(`topic-shift confirmer returned unparseable output: ${raw.slice(0, 200)}`);
        return false;
      }
      return (parsed as { newTopic: unknown }).newTopic === true;
    } catch (err) {
      const reason = controller.signal.aborted ? 'timeout' : err instanceof Error ? err.message : err;
      logger.warn(`topic-shift confirmer failed: ${reason}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

function confirmerPrompt(context: string, newPrompt: string): string {
  return [
    'A user is chatting with a desktop assistant. Given the conversation so far and their newest message, decide whether the newest message starts a genuinely different task or topic (not a follow-up, answer, correction, or aside within the current task).',
    '',
    'Conversation so far:',
    '---',
    context,
    '---',
    '',
    'Newest message:',
    '---',
    newPrompt,
    '---',
    '',
    'Respond with ONLY this JSON: {"newTopic": true} or {"newTopic": false}',
  ].join('\n');
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
