import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusFooter } from './StatusFooter';

describe('StatusFooter', () => {
  it('shows the private indicator (in place of the session id) when private', () => {
    render(<StatusFooter model="claude-sonnet-5-5" sessionId="sess-123" mode="balanced" isPrivate />);
    expect(screen.getByTestId('private-indicator')).toBeInTheDocument();
    // The raw session id is hidden for a private conversation.
    expect(screen.queryByText('sess-123')).toBeNull();
  });

  it('shows the session id and no private indicator by default', () => {
    render(<StatusFooter model="claude-sonnet-5-5" sessionId="sess-123" mode="balanced" />);
    expect(screen.queryByTestId('private-indicator')).toBeNull();
    expect(screen.getByText('sess-123')).toBeInTheDocument();
  });

  it('labels the model from the shared model list', () => {
    render(<StatusFooter model="claude-opus-5-5" sessionId={null} mode="balanced" />);
    expect(screen.getByText('Opus 5.5')).toBeInTheDocument();
  });
});
