import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Message as MessageType, ContentBlock } from '@shared/messages';
import { ToolCallCard } from './ToolCallCard';
import { ApprovalCard } from './ApprovalCard';
import { ProcessCard } from './ProcessCard';
import { rehypeEmojiIcons } from './rehype-emoji-icons';
import { EMOJI_TO_ICON, fluentEmojiUrl } from './emoji-icons';
import { OttoMark } from './OttoMark';

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
};

function MarkdownBlock({ text, caret }: { text: string; caret?: boolean }) {
  return (
    <div className="md text-sm leading-relaxed">
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
    const text = formatMemoryUpdate(block);
    if (!text) return null;
    return (
      <div className="text-[11px] text-muted italic py-1 px-3">{text}</div>
    );
  }
  if (message.role === 'user') {
    return (
      <div data-testid="message-user" className="otto-msg-enter flex justify-end my-3">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-accent/20 border border-accent/30 px-4 py-2 text-sm">
          {renderText(message.content)}
        </div>
      </div>
    );
  }
  if (message.role === 'assistant') {
    const cls = [
      'otto-msg-enter my-3',
      message.errored ? 'opacity-60' : '',
      message.cancelled ? 'opacity-70 italic' : '',
    ]
      .filter(Boolean)
      .join(' ');
    return (
      <div data-testid="message-assistant" className={cls}>
        <div className="flex items-center gap-1.5 mb-1 text-xs font-medium text-muted">
          <OttoMark className="w-3.5 h-3.5 text-accent" />
          <span>Otto</span>
        </div>
        {renderBlocks(message.content, isStreamingTarget)}
        {message.cancelled && <div className="text-xs text-muted mt-1">(cancelled)</div>}
        {message.errored && <div className="text-xs text-danger mt-1">(error)</div>}
      </div>
    );
  }
  return (
    <div data-testid="message-tool" className="otto-msg-enter my-3 text-xs text-muted font-mono">
      {renderBlocks(message.content, false)}
    </div>
  );
}

function renderText(content: ContentBlock[]): string {
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');
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
      elements.push(<MarkdownBlock key={`t-${textBufferStartIdx}`} text={textBuffer} />);
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
    elements.push(<MarkdownBlock key="t-tail" text={textBuffer} caret={caretHere} />);
  } else if (streamingTarget && lastTextIndex === -1) {
    // streaming has started but no text yet — show typing dots
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

function formatMemoryUpdate(block: Extract<ContentBlock, { type: 'memory-update' }>): string {
  const parts: string[] = [];
  if (block.playbooks > 0) parts.push(`${block.playbooks} playbook${block.playbooks === 1 ? '' : 's'}`);
  if (block.facts > 0) parts.push(`${block.facts} fact${block.facts === 1 ? '' : 's'}`);
  if (block.antiPatterns > 0) parts.push(`${block.antiPatterns} anti-pattern${block.antiPatterns === 1 ? '' : 's'}`);
  if (block.heuristics > 0) parts.push(`${block.heuristics} heuristic${block.heuristics === 1 ? '' : 's'}`);
  if (parts.length === 0) return '';
  return `${parts.join(', ')} created/updated`;
}
