import { visit, SKIP } from 'unist-util-visit';
import type { Root, Text, ElementContent } from 'hast';
import { EMOJI_REGEX } from './emoji-icons';

// Walks HAST text nodes and replaces mapped emoji graphemes with a marker
// <span class="otto-icon" data-emoji="…" /> element. The React renderer
// overrides `span.otto-icon` to draw the corresponding Lucide icon.
export function rehypeEmojiIcons() {
  return (tree: Root) => {
    visit(tree, 'text', (node: Text, index, parent) => {
      if (!parent || typeof index !== 'number') return;
      const text = node.value;
      EMOJI_REGEX.lastIndex = 0;
      if (!EMOJI_REGEX.test(text)) return;
      EMOJI_REGEX.lastIndex = 0;

      const out: ElementContent[] = [];
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = EMOJI_REGEX.exec(text)) !== null) {
        const emoji = m[1]!;
        if (m.index > last) out.push({ type: 'text', value: text.slice(last, m.index) });
        out.push({
          type: 'element',
          tagName: 'span',
          properties: {
            className: ['otto-icon'],
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
