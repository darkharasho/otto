import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import ReactMarkdown, { type Components } from 'react-markdown';
import { rehypeEmojiIcons } from './rehype-emoji-icons';
import { EMOJI_TO_ICON, twemojiUrl, twemojiCodepoint } from './emoji-icons';

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
        return <img data-testid={`twemoji-${emoji}`} src={twemojiUrl(emoji)} alt={emoji} />;
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

  it('falls back to Twemoji for unmapped emoji', () => {
    const { getByTestId } = renderMd('cool 🥥');
    const img = getByTestId('twemoji-🥥') as HTMLImageElement;
    expect(img).toBeInTheDocument();
    expect(img.src).toContain('twemoji');
    expect(img.src).toContain(twemojiCodepoint('🥥'));
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

describe('twemojiCodepoint', () => {
  it('encodes single-codepoint emoji', () => {
    expect(twemojiCodepoint('🥥')).toBe('1f965');
  });

  it('drops FE0F in multi-codepoint sequences', () => {
    expect(twemojiCodepoint('⚠️')).toBe('26a0');
  });

  it('keeps single-codepoint FE0F-only graphemes', () => {
    // bare ❤ without VS-16
    expect(twemojiCodepoint('❤')).toBe('2764');
  });

  it('joins ZWJ sequences with dashes', () => {
    // 👨‍💻 = U+1F468 ZWJ U+1F4BB
    expect(twemojiCodepoint('👨‍💻')).toBe('1f468-200d-1f4bb');
  });
});
