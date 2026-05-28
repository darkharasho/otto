import type { Repo } from '../db/repo';
import type { Embedder } from '../embeddings/embedder';
import type { ContentBlock, Message } from '@shared/messages';
import { CONTEXT_WINDOW_CHARS } from '@shared/topic-shift-constants';

export interface TopicShiftDetectorDeps {
  repo: Pick<Repo, 'loadMessages'>;
  embedder: Pick<Embedder, 'embedBatch' | 'isAvailable'>;
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
