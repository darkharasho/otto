import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import ReactMarkdown, { type Components } from 'react-markdown';
import { rehypeEmojiIcons } from './rehype-emoji-icons';
import { EMOJI_TO_ICON } from './emoji-icons';

const components: Components = {
  span(props) {
    const { className, children, node: _n, ...rest } = props as typeof props & {
      'data-emoji'?: string;
    };
    const classes = Array.isArray(className) ? className.join(' ') : className ?? '';
    if (classes.includes('otto-icon')) {
      const emoji = (props as { 'data-emoji'?: string })['data-emoji'];
      const Icon = emoji ? EMOJI_TO_ICON[emoji] : undefined;
      if (Icon) return <Icon data-testid={`icon-${emoji}`} />;
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

  it('leaves unmapped emoji as text', () => {
    const { container, queryByTestId } = renderMd('cool 🥥');
    expect(container.textContent).toContain('🥥');
    expect(queryByTestId(/^icon-/)).toBeNull();
  });

  it('works inside inline markdown like bold', () => {
    const { getByTestId } = renderMd('**heads up** 🚨');
    expect(getByTestId('icon-🚨')).toBeInTheDocument();
  });
});
