export const NEW_CONVERSATION_PREFIX = '/n ';

export interface ParsedNewConversationPrefix {
  remainder: string;
}

export function parseNewConversationPrefix(
  buffer: string,
): ParsedNewConversationPrefix | null {
  if (!buffer.startsWith(NEW_CONVERSATION_PREFIX)) return null;
  return { remainder: buffer.slice(NEW_CONVERSATION_PREFIX.length) };
}

export const PRIVATE_CONVERSATION_PREFIX = '/p ';

export interface ParsedPrivateConversationPrefix {
  remainder: string;
}

export function parsePrivateConversationPrefix(
  buffer: string,
): ParsedPrivateConversationPrefix | null {
  if (!buffer.startsWith(PRIVATE_CONVERSATION_PREFIX)) return null;
  return { remainder: buffer.slice(PRIVATE_CONVERSATION_PREFIX.length) };
}
