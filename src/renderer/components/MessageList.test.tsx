import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageList } from './MessageList';

describe('MessageList — new conversation divider', () => {
  it('renders a "New conversation" divider when startedAt is set', () => {
    render(
      <MessageList
        sessionId="s1"
        messages={[]}
        streaming={false}
        startedAt={new Date('2026-05-27T14:14:00').getTime()}
      />,
    );
    expect(screen.getByText(/New conversation/)).toBeInTheDocument();
  });

  it('does not render the divider when startedAt is null', () => {
    render(
      <MessageList
        sessionId="s1"
        messages={[]}
        streaming={false}
        startedAt={null}
      />,
    );
    expect(screen.queryByText(/New conversation/)).toBeNull();
  });
});
