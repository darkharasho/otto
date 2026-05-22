import type { Message as MessageType, ContentBlock } from '@shared/messages';
import { ToolCallCard } from './ToolCallCard';
import { ApprovalCard } from './ApprovalCard';

interface Props {
  message: MessageType;
}

export function MessageView({ message }: Props) {
  if (message.role === 'user') {
    return (
      <div data-testid="message-user" className="flex justify-end my-3">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-accent/20 border border-accent/30 px-4 py-2 text-sm">
          {renderText(message.content)}
        </div>
      </div>
    );
  }
  if (message.role === 'assistant') {
    const cls = ['my-3', message.errored ? 'opacity-60' : '', message.cancelled ? 'opacity-70 italic' : '']
      .filter(Boolean)
      .join(' ');
    return (
      <div data-testid="message-assistant" className={cls}>
        {renderBlocks(message.content)}
        {message.cancelled && <div className="text-xs text-muted mt-1">(cancelled)</div>}
        {message.errored && <div className="text-xs text-danger mt-1">(error)</div>}
      </div>
    );
  }
  return (
    <div data-testid="message-tool" className="my-3 text-xs text-muted font-mono">
      {renderBlocks(message.content)}
    </div>
  );
}

function renderText(content: ContentBlock[]): string {
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

function renderBlocks(content: ContentBlock[]) {
  const elements: React.ReactNode[] = [];
  const toolResults = new Map<string, { result: unknown; isError: boolean }>();
  for (const b of content) {
    if (b.type === 'tool_result') toolResults.set(b.callId, { result: b.result, isError: b.isError ?? false });
  }
  let textBuffer = '';
  for (let i = 0; i < content.length; i += 1) {
    const b = content[i]!;
    if (b.type === 'text') {
      textBuffer += b.text;
      continue;
    }
    if (textBuffer) {
      elements.push(<p key={`t-${i}`} className="text-sm leading-relaxed whitespace-pre-wrap">{textBuffer}</p>);
      textBuffer = '';
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
    elements.push(<p key="t-tail" className="text-sm leading-relaxed whitespace-pre-wrap">{textBuffer}</p>);
  }
  return <>{elements}</>;
}
