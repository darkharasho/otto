import { describe, it, expect } from 'vitest';
import {
  isUserMessage,
  isAssistantMessage,
  isToolMessage,
  isSystemMessage,
  newUserMessage,
  newAssistantMessage,
  newSystemMessage,
  type Message,
  type SystemMessage,
  type ContentBlock,
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

describe('SystemMessage', () => {
  it('newSystemMessage produces a system-role message with the given content', () => {
    const block: ContentBlock = {
      type: 'memory-update',
      facts: 1,
      playbooks: 2,
      antiPatterns: 0,
      heuristics: 1,
    };
    const m: SystemMessage = newSystemMessage([block]);
    expect(m.role).toBe('system');
    expect(m.content).toEqual([block]);
    expect(typeof m.id).toBe('string');
    expect(typeof m.createdAt).toBe('number');
  });

  it('isSystemMessage type guard returns true for system role and false for others', () => {
    const sys = newSystemMessage([
      { type: 'memory-update', facts: 1, playbooks: 0, antiPatterns: 0, heuristics: 0 },
    ]);
    expect(isSystemMessage(sys)).toBe(true);
  });
});
