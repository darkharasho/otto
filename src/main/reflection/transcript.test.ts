import { describe, it, expect } from 'vitest';
import { buildTranscriptSlice } from './transcript';
import type { Message } from '@shared/messages';
import { newUserMessage, newAssistantMessage } from '@shared/messages';

function userMsg(text: string, seq: number): Message {
  return { ...newUserMessage(text), seq } as Message;
}
function assistantMsg(seq: number, blocks: Array<{ type: 'text'; text: string } | { type: 'tool_use'; callId: string; name: string; input: unknown } | { type: 'tool_result'; callId: string; result: unknown; isError: boolean }>): Message {
  const base = newAssistantMessage();
  return { ...base, content: blocks, seq } as Message;
}

describe('buildTranscriptSlice', () => {
  it('returns text for user, assistant text, tool calls, and tool results in seq order', () => {
    const msgs: Message[] = [
      userMsg('please fix audio', 0),
      assistantMsg(1, [
        { type: 'text', text: 'looking now' },
        { type: 'tool_use', callId: 'c1', name: 'shell_exec', input: { command: 'pactl list' } },
        { type: 'tool_result', callId: 'c1', result: 'sink #0 ...', isError: false },
        { type: 'text', text: 'restarting pipewire' },
      ]),
    ];
    const out = buildTranscriptSlice(msgs, 100_000);
    expect(out.text).toContain('USER: please fix audio');
    expect(out.text).toContain('ASSISTANT: looking now');
    expect(out.text).toContain('TOOL_CALL shell_exec');
    expect(out.text).toContain('TOOL_RESULT c1');
    expect(out.text).toContain('sink #0');
    expect(out.text.indexOf('USER:')).toBeLessThan(out.text.indexOf('ASSISTANT:'));
  });

  it('truncates oversized tool results with an elided marker, leaves text intact', () => {
    const huge = 'x'.repeat(5000);
    const msgs: Message[] = [
      assistantMsg(0, [
        { type: 'tool_use', callId: 'c1', name: 'shell_exec', input: { command: 'ls' } },
        { type: 'tool_result', callId: 'c1', result: huge, isError: false },
        { type: 'text', text: 'short text stays intact' },
      ]),
    ];
    const out = buildTranscriptSlice(msgs, 500); // tiny budget
    expect(out.text).toContain('[…elided…]');
    expect(out.text).toContain('short text stays intact');
    expect(out.truncated).toBe(true);
  });

  it('extracts the original user request as the first user message text', () => {
    const msgs: Message[] = [
      userMsg('original ask', 0),
      assistantMsg(1, [{ type: 'text', text: 'ok' }]),
      userMsg('followup', 2),
    ];
    const out = buildTranscriptSlice(msgs, 100_000);
    expect(out.originalRequest).toBe('original ask');
  });

  it('originalRequest is empty when slice has no user message', () => {
    const msgs: Message[] = [assistantMsg(0, [{ type: 'text', text: 'standalone' }])];
    const out = buildTranscriptSlice(msgs, 100_000);
    expect(out.originalRequest).toBe('');
  });
});
