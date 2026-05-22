import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageView } from './Message';
import type { Message } from '@shared/messages';

const baseUser: Message = {
  id: 'm1',
  sessionId: 's1',
  seq: 0,
  createdAt: 0,
  role: 'user',
  content: [{ type: 'text', text: 'hi otto' }],
};

const baseAssistant: Message = {
  id: 'm2',
  sessionId: 's1',
  seq: 1,
  createdAt: 0,
  role: 'assistant',
  content: [{ type: 'text', text: 'hi user' }],
  cancelled: false,
  errored: false,
};

describe('MessageView', () => {
  it('renders a user message right-aligned with text', () => {
    render(<MessageView message={baseUser} />);
    expect(screen.getByText('hi otto')).toBeInTheDocument();
    expect(screen.getByTestId('message-user')).toBeInTheDocument();
  });

  it('renders an assistant message with text', () => {
    render(<MessageView message={baseAssistant} />);
    expect(screen.getByText('hi user')).toBeInTheDocument();
    expect(screen.getByTestId('message-assistant')).toBeInTheDocument();
  });

  it('renders a tool_use block as a ToolCallCard', () => {
    const m: Message = {
      ...baseAssistant,
      content: [
        { type: 'tool_use', callId: 'c1', name: 'echo', input: { msg: 'hi' } },
        { type: 'tool_result', callId: 'c1', result: 'hi', isError: false },
      ],
    };
    render(<MessageView message={m} />);
    expect(screen.getByText('echo')).toBeInTheDocument();
  });

  it('marks an errored assistant message', () => {
    render(<MessageView message={{ ...baseAssistant, errored: true } as Message} />);
    expect(screen.getByTestId('message-assistant')).toHaveClass('opacity-60');
  });
});
