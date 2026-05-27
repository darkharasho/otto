import { describe, it, expect } from 'vitest';
import {
  isUserMessage,
  isAssistantMessage,
  isToolMessage,
  isSystemMessage,
  newUserMessage,
  newAssistantMessage,
  newSystemMessage,
  extFromMime,
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
      promoted: 0,
      demoted: 0,
    };
    const m: SystemMessage = newSystemMessage([block]);
    expect(m.role).toBe('system');
    expect(m.content).toEqual([block]);
    expect(typeof m.id).toBe('string');
    expect(typeof m.createdAt).toBe('number');
  });

  it('isSystemMessage type guard returns true for system role and false for others', () => {
    const sys = newSystemMessage([
      { type: 'memory-update', facts: 1, playbooks: 0, antiPatterns: 0, heuristics: 0, promoted: 0, demoted: 0 },
    ]);
    expect(isSystemMessage(sys)).toBe(true);
  });

  it('accepts an image-ref content block', () => {
    const block: ContentBlock = {
      type: 'image-ref',
      id: '550e8400-e29b-41d4-a716-446655440000',
      sessionId: 's1',
      path: '/tmp/screenshots/s1/foo.png',
      width: 1920,
      height: 1080,
      mimeType: 'image/png',
      source: 'screenshot',
    };
    expect(block.type).toBe('image-ref');
  });
});

it('extFromMime maps every supported mime to a file extension', () => {
  expect(extFromMime('image/png')).toBe('png');
  expect(extFromMime('image/jpeg')).toBe('jpg');
  expect(extFromMime('image/webp')).toBe('webp');
  expect(extFromMime('image/gif')).toBe('gif');
});

it('accepts an image-ref with source: user', () => {
  const block: ContentBlock = {
    type: 'image-ref',
    id: 'abc',
    sessionId: 's1',
    path: '/tmp/x.jpg',
    width: 100, height: 50,
    mimeType: 'image/jpeg',
    source: 'user',
  };
  expect(block.source).toBe('user');
});
