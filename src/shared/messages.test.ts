import { describe, it, expect } from 'vitest';
import {
  isUserMessage,
  isAssistantMessage,
  isToolMessage,
  newUserMessage,
  newAssistantMessage,
  type Message,
} from './messages';

describe('messages', () => {
  it('creates a user message with text content', () => {
    const m = newUserMessage('hello');
    expect(m.role).toBe('user');
    expect(m.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(m.id).toMatch(/^msg_/);
    expect(typeof m.createdAt).toBe('number');
  });

  it('creates an assistant message that starts empty and is not cancelled', () => {
    const m = newAssistantMessage();
    expect(m.role).toBe('assistant');
    expect(m.content).toEqual([]);
    expect(m.cancelled).toBe(false);
  });

  it('discriminates message roles', () => {
    const u: Message = newUserMessage('hi');
    const a: Message = newAssistantMessage();
    expect(isUserMessage(u)).toBe(true);
    expect(isAssistantMessage(a)).toBe(true);
    expect(isToolMessage(u)).toBe(false);
  });
});
