import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NowStrip } from './NowStrip';
import { useOttoStore } from '../state/store';
import type { Message } from '@shared/messages';

function assistantMessage(content: Message['content']): Message {
  return {
    id: 'a1',
    sessionId: 's1',
    seq: 1,
    createdAt: Date.now(),
    role: 'assistant',
    content,
    cancelled: false,
    errored: false,
  } as Message;
}

describe('NowStrip', () => {
  beforeEach(() => {
    useOttoStore.setState({ activeSession: null });
  });

  it('renders nothing without an active session', () => {
    const { container } = render(<NowStrip onStop={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the quiet state when nothing is running', () => {
    useOttoStore.setState({
      activeSession: {
        id: 's1',
        messages: [assistantMessage([{ type: 'text', text: 'done' }])],
        currentTurnActive: false,
        queueDepth: 0,
        error: null,
      },
    });
    render(<NowStrip onStop={() => {}} />);
    expect(screen.getByText(/all quiet — nothing running/i)).toBeInTheDocument();
  });

  it('lists in-flight tool calls with a Pause all control', async () => {
    useOttoStore.setState({
      activeSession: {
        id: 's1',
        messages: [
          assistantMessage([
            { type: 'tool_use', callId: 'c1', name: 'shell_exec', input: { command: 'pidstat 1' } },
          ]),
        ],
        currentTurnActive: true,
        queueDepth: 0,
        error: null,
      },
    });
    const onStop = vi.fn();
    render(<NowStrip onStop={onStop} />);
    expect(screen.getByText(/1 running/)).toBeInTheDocument();
    expect(screen.getByText(/run command/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /pause all/i }));
    expect(onStop).toHaveBeenCalled();
  });

  it('counts a running spawned process even after the turn ended', () => {
    useOttoStore.setState({
      activeSession: {
        id: 's1',
        messages: [
          assistantMessage([
            { type: 'process_output', handle: 'h1', command: 'inotifywait -m ~/Videos', cwd: '/', lines: [], status: 'running', exitCode: null },
          ]),
        ],
        currentTurnActive: false,
        queueDepth: 0,
        error: null,
      },
    });
    render(<NowStrip onStop={() => {}} />);
    expect(screen.getByText(/1 running/)).toBeInTheDocument();
    expect(screen.getByText(/inotifywait/)).toBeInTheDocument();
  });
});
