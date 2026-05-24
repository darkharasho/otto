import type { Message, ContentBlock } from '@shared/messages';

export interface TranscriptSlice {
  text: string;
  originalRequest: string;
  truncated: boolean;
}

const ELIDE_MARKER = '[…elided…]';

export function buildTranscriptSlice(messages: Message[], byteBudget: number): TranscriptSlice {
  const sorted = [...messages].sort((a, b) => a.seq - b.seq);
  const lines: string[] = [];
  let originalRequest = '';

  for (const msg of sorted) {
    if (msg.role === 'user') {
      const text = userText(msg.content);
      if (!originalRequest && text) originalRequest = text;
      lines.push(`USER: ${text}`);
      continue;
    }
    if (msg.role === 'assistant') {
      for (const block of msg.content) {
        if (block.type === 'text') {
          lines.push(`ASSISTANT: ${block.text}`);
        } else if (block.type === 'tool_use') {
          lines.push(`TOOL_CALL ${block.name} (${block.callId}): ${safeJson(block.input)}`);
        } else if (block.type === 'tool_result') {
          lines.push(`TOOL_RESULT ${block.callId}${block.isError ? ' [ERROR]' : ''}: ${stringifyResult(block.result)}`);
        }
      }
    }
  }

  const truncated = applyBudget(lines, byteBudget);
  return { text: lines.join('\n'), originalRequest, truncated };
}

function userText(content: ContentBlock[]): string {
  return content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
}

function stringifyResult(r: unknown): string {
  if (typeof r === 'string') return r;
  return safeJson(r);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function applyBudget(lines: string[], byteBudget: number): boolean {
  let total = lines.reduce((n, l) => n + l.length + 1, 0);
  if (total <= byteBudget) return false;

  const resultIdx = lines
    .map((l, i) => ({ i, len: l.length, isResult: l.startsWith('TOOL_RESULT ') }))
    .filter((e) => e.isResult)
    .sort((a, b) => b.len - a.len);

  for (const e of resultIdx) {
    if (total <= byteBudget) break;
    const original = lines[e.i]!;
    const prefix = original.slice(0, original.indexOf(': ') + 2);
    const replacement = `${prefix}${ELIDE_MARKER}`;
    total -= original.length - replacement.length;
    lines[e.i] = replacement;
  }
  return true;
}
