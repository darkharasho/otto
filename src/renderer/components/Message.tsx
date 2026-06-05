import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Message as MessageType, ContentBlock } from '@shared/messages';
import { extFromMime } from '@shared/messages';
import { ToolCallCard } from './ToolCallCard';
import { ApprovalCard } from './ApprovalCard';
import { ProcessCard } from './ProcessCard';
import { rehypeEmojiIcons } from './rehype-emoji-icons';
import { EMOJI_TO_ICON, fluentEmojiUrl } from './emoji-icons';
import { OttoMark } from './OttoMark';
import { toLocalImageSrc } from '@shared/image-src';
import { classifyErrorText, InlineErrorCard } from './ErrorCard';

const markdownComponents: Components = {
  // The rehype plugin emits <span class="otto-emoji" data-emoji="…" />; we
  // render Lucide for mapped emojis and OpenMoji Black (line-style mono SVG)
  // for everything else. OpenMoji is drawn black, so we invert it to read on
  // the dark surface and dim it slightly so it doesn't out-shout the text.
  span(props) {
    const { className, children, node: _n, ...rest } = props as typeof props & {
      'data-emoji'?: string;
    };
    const classes = Array.isArray(className) ? className.join(' ') : className ?? '';
    if (classes.includes('otto-emoji')) {
      const emoji = (props as { 'data-emoji'?: string })['data-emoji'];
      if (emoji) {
        const Icon = EMOJI_TO_ICON[emoji];
        if (Icon) {
          return (
            <Icon
              className="inline-block align-[-0.2em] mx-[0.1em] w-[1.1em] h-[1.1em] text-accent"
              strokeWidth={2.25}
              aria-label={emoji}
            />
          );
        }
        const url = fluentEmojiUrl(emoji);
        if (url) {
          return (
            <span
              role="img"
              aria-label={emoji}
              title={emoji}
              className="otto-emoji-mask text-accent"
              style={{
                WebkitMaskImage: `url(${url})`,
                maskImage: `url(${url})`,
              }}
            />
          );
        }
        // No icon for this emoji — render nothing visible rather than break
        // the line-icon aesthetic with a colorful native glyph.
        return null;
      }
    }
    return (
      <span className={classes} {...rest}>
        {children}
      </span>
    );
  },
  img(props) {
    const { src, alt } = props as { src?: string; alt?: string };
    const resolved = toLocalImageSrc(src, { kind: 'electron' });
    if (!resolved) return null;
    // span+block instead of figure/figcaption — react-markdown wraps images in
    // <p>, and <figure> as a <p> descendant is invalid HTML.
    return (
      <span className="block my-2 max-w-sm">
        <img
          src={resolved}
          alt={alt ?? ''}
          loading="lazy"
          className="rounded-md border border-border w-full h-auto bg-bg/40"
        />
        {alt && <span className="block mt-1 text-[11px] text-muted italic">{alt}</span>}
      </span>
    );
  },
};

function MarkdownBlock({ text, caret }: { text: string; caret?: boolean }) {
  return (
    <div className="md text-sm leading-[1.6]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeEmojiIcons]}
        components={markdownComponents}
      >
        {text}
      </ReactMarkdown>
      {caret && (
        <span className="otto-typing text-accent align-middle inline-flex" aria-hidden>
          <span />
          <span />
          <span />
        </span>
      )}
    </div>
  );
}

interface Props {
  message: MessageType;
  isStreamingTarget?: boolean;
}

export function MessageView({ message, isStreamingTarget = false }: Props) {
  if (message.role === 'system') {
    const block = message.content[0];
    if (!block || block.type !== 'memory-update') return null;
    const counts = {
      playbooks: block.playbooks,
      facts: block.facts,
      anti_patterns: block.antiPatterns,
      heuristics: block.heuristics,
      promoted: block.promoted,
      demoted: block.demoted,
    };
    const changed = Object.values(counts).some((n) => n > 0);
    return (
      <div data-testid="message-memory-update" className="otto-msg-enter my-3">
        <ToolCallCard name={changed ? 'memory_save' : 'memory_noop'} input={counts} result={null} isError={false} />
      </div>
    );
  }
  if (message.role === 'user') {
    return (
      <div data-testid="message-user" className="otto-msg-enter flex justify-end my-3">
        <div className="max-w-[80%] rounded-2xl rounded-br-md px-4 py-2 text-sm text-text bg-gradient-to-b from-accent/[0.18] to-accent/[0.12] border border-accent/30 shadow-[0_2px_10px_-4px_rgba(110,111,255,0.35)]">
          {message.content.map((b, i) => {
            if (b.type === 'text') return <span key={i}>{b.text}</span>;
            if (b.type === 'image-ref') {
              const scheme = b.source === 'user' ? 'otto-user-image' : 'otto-image';
              const src = `${scheme}://${b.sessionId}/${b.id}.${extFromMime(b.mimeType)}`;
              return (
                <img
                  key={i}
                  src={src}
                  alt=""
                  className="max-w-[200px] rounded mt-1 block"
                  loading="lazy"
                />
              );
            }
            return null;
          })}
        </div>
      </div>
    );
  }
  if (message.role === 'assistant') {
    const cls = [
      'otto-msg-enter my-3',
      message.cancelled ? 'opacity-70 italic' : '',
    ]
      .filter(Boolean)
      .join(' ');
    return (
      <div data-testid="message-assistant" className={cls}>
        <div className="flex items-center gap-1.5 mb-1 text-xs font-medium text-muted">
          <span className="otto-mark-halo"><OttoMark className="w-3.5 h-3.5 text-accent" /></span>
          <span>Otto</span>
        </div>
        {renderBlocks(message.content, isStreamingTarget)}
        {message.cancelled && <div className="text-xs text-muted mt-1">(cancelled)</div>}
      </div>
    );
  }
  return (
    <div data-testid="message-tool" className="otto-msg-enter my-3 text-xs text-muted font-mono">
      {renderBlocks(message.content, false)}
    </div>
  );
}


function renderBlocks(content: ContentBlock[], streamingTarget: boolean) {
  const elements: React.ReactNode[] = [];
  const toolResults = new Map<string, { result: unknown; isError: boolean }>();
  for (const b of content) {
    if (b.type === 'tool_result') toolResults.set(b.callId, { result: b.result, isError: b.isError ?? false });
  }

  // Caret goes on the trailing text run only (visual cursor where new tokens land).
  let lastTextIndex = -1;
  for (let i = content.length - 1; i >= 0; i -= 1) {
    if (content[i]!.type === 'text') {
      lastTextIndex = i;
      break;
    }
  }

  function flushText(buf: string, key: string, caret?: boolean) {
    const classified = classifyErrorText(buf);
    if (classified) {
      elements.push(<InlineErrorCard key={key} headline={classified.headline} details={buf} />);
    } else {
      elements.push(<MarkdownBlock key={key} text={buf} caret={caret} />);
    }
  }

  let textBuffer = '';
  let textBufferStartIdx = -1;
  for (let i = 0; i < content.length; i += 1) {
    const b = content[i]!;
    if (b.type === 'text') {
      if (textBufferStartIdx === -1) textBufferStartIdx = i;
      textBuffer += b.text;
      continue;
    }
    if (textBuffer) {
      flushText(textBuffer, `t-${textBufferStartIdx}`);
      textBuffer = '';
      textBufferStartIdx = -1;
    }
    if (b.type === 'tool_use') {
      const res = toolResults.get(b.callId);
      elements.push(
        <ToolCallCard
          key={b.callId}
          name={b.name}
          input={b.input}
          result={res?.result}
          isError={res?.isError ?? false}
        />
      );
    } else if (b.type === 'pending_tool_use') {
      elements.push(<ApprovalCard key={b.callId} block={b} />);
    } else if (b.type === 'process_output') {
      elements.push(<ProcessCard key={b.handle} block={b} />);
    } else if (b.type === 'tool_denied') {
      elements.push(
        <div
          key={b.callId}
          className="my-2 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm"
        >
          <div className="font-medium text-danger">{b.name} — denied</div>
          <div className="text-xs text-muted mt-1">{b.reason}</div>
        </div>
      );
    }
  }
  if (textBuffer) {
    const caretHere = streamingTarget && textBufferStartIdx <= lastTextIndex;
    flushText(textBuffer, 't-tail', caretHere);
  }
  // Thinking dots: streaming target whose last block isn't actively-streaming
  // text — covers pre-first-token, gaps between tool calls, and pauses after
  // a tool result while the model is generating the next block.
  const lastBlock = content[content.length - 1];
  if (streamingTarget && (!lastBlock || lastBlock.type !== 'text')) {
    elements.push(
      <div key="t-empty" className="text-accent otto-typing" aria-label="Otto is typing">
        <span />
        <span />
        <span />
      </div>
    );
  }
  return <>{elements}</>;
}

