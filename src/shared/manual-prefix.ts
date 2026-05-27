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
