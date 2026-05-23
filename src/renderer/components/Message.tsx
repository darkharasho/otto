import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Message as MessageType, ContentBlock } from '@shared/messages';
import { ToolCallCard } from './ToolCallCard';
import { ApprovalCard } from './ApprovalCard';
import { ProcessCard } from './ProcessCard';

function MarkdownBlock({ text, caret }: { text: string; caret?: boolean }) {
  return (
    <div className="md text-sm leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      {caret && <span className="otto-caret -ml-1 text-accent" aria-hidden />}
    </div>
  );
}

interface Props {
  message: MessageType;
  isStreamingTarget?: boolean;
}

export function MessageView({ message, isStreamingTarget = false }: Props) {
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
    // streaming has started but no text yet — show caret alone
    elements.push(<MarkdownBlock key="t-empty" text="" caret />);
  }
  return <>{elements}</>;
}
