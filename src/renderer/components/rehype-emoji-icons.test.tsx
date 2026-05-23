import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import ReactMarkdown, { type Components } from 'react-markdown';
import { rehypeEmojiIcons } from './rehype-emoji-icons';
import { EMOJI_TO_ICON, fluentEmojiSlug, fluentEmojiUrl } from './emoji-icons';

const components: Components = {
  span(props) {
    const { className, children, node: _n, ...rest } = props as typeof props & {
      'data-emoji'?: string;
    };
    const classes = Array.isArray(className) ? className.join(' ') : className ?? '';
    if (classes.includes('otto-emoji')) {
      const emoji = (props as { 'data-emoji'?: string })['data-emoji'];
      if (emoji) {
        const Icon = EMOJI_TO_ICON[emoji];
        if (Icon) return <Icon data-testid={`icon-${emoji}`} />;
        const url = fluentEmojiUrl(emoji);
        if (url) return <span data-testid={`fluent-${emoji}`} data-src={url} />;
        return null;
      }
    }
    return (
      <span className={classes} {...rest}>
        {children}
      </span>
    );
  },
};

function renderMd(text: string) {
  return render(
    <ReactMarkdown rehypePlugins={[rehypeEmojiIcons]} components={components}>
      {text}
    </ReactMarkdown>
  );
}

describe('rehypeEmojiIcons', () => {
  it('replaces a mapped emoji with a Lucide icon', () => {
    const { getByTestId } = renderMd('All done ✅');
    expect(getByTestId('icon-✅')).toBeInTheDocument();
  });

  it('handles multiple emojis and preserves surrounding text', () => {
    const { container, getByTestId } = renderMd('⚠️ careful, this is ❌');
    expect(getByTestId('icon-⚠️')).toBeInTheDocument();
    expect(getByTestId('icon-❌')).toBeInTheDocument();
    expect(container.textContent).toContain('careful, this is');
  });

  it('falls back to Fluent High Contrast for unmapped emoji', () => {
    const { getByTestId } = renderMd('😂 nice');
    const el = getByTestId('fluent-😂');
    expect(el).toBeInTheDocument();
    expect(el.dataset.src).toContain('fluent-emoji-high-contrast/face-with-tears-of-joy');
  });

  it('works inside inline markdown like bold', () => {
    const { getByTestId } = renderMd('**heads up** 🚨');
    expect(getByTestId('icon-🚨')).toBeInTheDocument();
  });

  it('maps thumbs up to Lucide ThumbsUp', () => {
    const { getByTestId } = renderMd('👍');
    expect(getByTestId('icon-👍')).toBeInTheDocument();
  });
});

describe('fluentEmojiSlug', () => {
  it('converts the unicode-emoji-json slug to kebab case', () => {
    expect(fluentEmojiSlug('😂')).toBe('face-with-tears-of-joy');
    expect(fluentEmojiSlug('🥰')).toBe('smiling-face-with-hearts');
    expect(fluentEmojiSlug('🖌️')).toBe('paintbrush');
  });

  it('falls back to the base emoji when a skin-tone modifier is present', () => {
    expect(fluentEmojiSlug('👍🏽')).toBe('thumbs-up');
  });

  it('returns null when the emoji is unknown', () => {
    expect(fluentEmojiSlug('💩💩totally-not-an-emoji')).toBeNull();
  });
});
