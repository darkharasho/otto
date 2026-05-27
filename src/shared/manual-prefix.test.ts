import { describe, expect, it } from 'vitest';
import { parseNewConversationPrefix, NEW_CONVERSATION_PREFIX } from './manual-prefix';

describe('parseNewConversationPrefix', () => {
  it('exports the literal prefix "/n "', () => {
    expect(NEW_CONVERSATION_PREFIX).toBe('/n ');
  });

  it('returns null when buffer does not start with the prefix', () => {
    expect(parseNewConversationPrefix('hello')).toBeNull();
    expect(parseNewConversationPrefix('say /n now')).toBeNull();
    expect(parseNewConversationPrefix('/notice this')).toBeNull();
  });

  it('returns empty remainder when buffer is exactly the prefix', () => {
    expect(parseNewConversationPrefix('/n ')).toEqual({ remainder: '' });
  });

  it('returns the trailing text as remainder', () => {
    expect(parseNewConversationPrefix('/n hello world')).toEqual({
      remainder: 'hello world',
    });
  });

  it('preserves leading whitespace inside the remainder beyond the single separator space', () => {
    expect(parseNewConversationPrefix('/n  extra')).toEqual({ remainder: ' extra' });
  });

  it('does not match "/n" without a trailing space', () => {
    expect(parseNewConversationPrefix('/n')).toBeNull();
    expect(parseNewConversationPrefix('/nhello')).toBeNull();
  });
});
