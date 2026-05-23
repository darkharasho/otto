import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import ReactMarkdown, { type Components } from 'react-markdown';
import { rehypeEmojiIcons } from './rehype-emoji-icons';
import { EMOJI_TO_ICON, openmojiUrl, openmojiCodepoint } from './emoji-icons';

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
        return <img data-testid={`openmoji-${emoji}`} src={openmojiUrl(emoji)} alt={emoji} />;
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

  it('falls back to OpenMoji Black for unmapped emoji', () => {
    const { getByTestId } = renderMd('cool 🥥');
    const img = getByTestId('openmoji-🥥') as HTMLImageElement;
    expect(img).toBeInTheDocument();
    expect(img.src).toContain('openmoji');
    expect(img.src).toContain(openmojiCodepoint('🥥'));
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

describe('openmojiCodepoint', () => {
  it('encodes single-codepoint emoji in uppercase hex', () => {
    expect(openmojiCodepoint('🥥')).toBe('1F965');
  });

  it('preserves FE0F in multi-codepoint sequences (OpenMoji convention)', () => {
    expect(openmojiCodepoint('⚠️')).toBe('26A0-FE0F');
  });

  it('joins ZWJ sequences with dashes', () => {
    // 👨‍💻 = U+1F468 ZWJ U+1F4BB
    expect(openmojiCodepoint('👨‍💻')).toBe('1F468-200D-1F4BB');
  });
});
