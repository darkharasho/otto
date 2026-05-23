import { visit, SKIP } from 'unist-util-visit';
import type { Root, Text, ElementContent } from 'hast';
import { makeEmojiRegex } from './emoji-icons';

// Walks HAST text nodes and replaces *every* emoji grapheme with a marker
// <span class="otto-emoji" data-emoji="…" /> element. The React renderer
// decides whether to draw a Lucide icon (mapped emojis) or fall back to a
// Twemoji SVG (everything else).
export function rehypeEmojiIcons() {
  return (tree: Root) => {
    visit(tree, 'text', (node: Text, index, parent) => {
      if (!parent || typeof index !== 'number') return;
      const text = node.value;
      const regex = makeEmojiRegex();
      if (!regex.test(text)) return;
      regex.lastIndex = 0;

      const out: ElementContent[] = [];
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(text)) !== null) {
        const emoji = m[0];
        if (m.index > last) out.push({ type: 'text', value: text.slice(last, m.index) });
        out.push({
          type: 'element',
          tagName: 'span',
          properties: {
            className: ['otto-emoji'],
            'data-emoji': emoji,
          },
          children: [],
        });
        last = m.index + emoji.length;
      }
      if (last < text.length) out.push({ type: 'text', value: text.slice(last) });

      parent.children.splice(index, 1, ...out);
      return [SKIP, index + out.length];
    });
  };
}
