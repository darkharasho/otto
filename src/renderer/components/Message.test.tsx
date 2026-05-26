import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageView } from './Message';
import type { Message } from '@shared/messages';
import { newSystemMessage } from '@shared/messages';

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

describe('MessageView system memory-update', () => {
  function renderSystem(counts: {
    facts: number;
    playbooks: number;
    antiPatterns: number;
    heuristics: number;
    promoted?: number;
    demoted?: number;
  }) {
    const msg = {
      ...newSystemMessage([
        { type: 'memory-update' as const, promoted: 0, demoted: 0, ...counts },
      ]),
      sessionId: 's1',
    };
    return render(<MessageView message={msg} isStreamingTarget={false} />);
  }

  it('renders a Memory updated tool card with a summary of counts', () => {
    renderSystem({ facts: 1, playbooks: 2, antiPatterns: 0, heuristics: 0 });
    expect(screen.getByTestId('message-memory-update')).toBeInTheDocument();
    expect(screen.getByText('Memory updated')).toBeInTheDocument();
    expect(screen.getByText('2 playbooks, 1 fact')).toBeInTheDocument();
  });

  it('omits zero-count kinds from the summary', () => {
    renderSystem({ facts: 0, playbooks: 0, antiPatterns: 1, heuristics: 0 });
    expect(screen.getByText('1 anti-pattern')).toBeInTheDocument();
  });

  it('pluralizes correctly', () => {
    renderSystem({ facts: 3, playbooks: 1, antiPatterns: 2, heuristics: 4 });
    expect(screen.getByText('1 playbook, 3 facts, 2 anti-patterns, 4 heuristics')).toBeInTheDocument();
  });

  it('renders nothing when all counts are zero', () => {
    const { container } = renderSystem({ facts: 0, playbooks: 0, antiPatterns: 0, heuristics: 0 });
    expect(container.textContent ?? '').toBe('');
  });
});

describe('MessageView inline markdown images', () => {
  it('rewrites img src to the otto-img:// scheme and shows the alt caption', () => {
    const m: Message = {
      ...baseAssistant,
      content: [{ type: 'text', text: 'Found it: ![chest location](https://wiki.example.com/chest.png)' }],
    };
    render(<MessageView message={m} />);
    const img = screen.getByAltText('chest location') as HTMLImageElement;
    expect(img.getAttribute('src')).toMatch(/^otto-img:\/\/\/\?u=/);
    expect(screen.getByText('chest location')).toBeInTheDocument();
  });

  it('drops images with non-http(s) src silently', () => {
    const m: Message = {
      ...baseAssistant,
      content: [{ type: 'text', text: 'sketchy ![x](javascript:alert(1))' }],
    };
    render(<MessageView message={m} />);
    expect(screen.queryByAltText('x')).not.toBeInTheDocument();
  });
});

describe('MessageView mark_task_complete suppression', () => {
  it('hides mark_task_complete tool_use and its result', () => {
    const m: Message = {
      ...baseAssistant,
      content: [
        { type: 'text', text: 'all done' },
        { type: 'tool_use', callId: 'c1', name: 'mcp__otto-tools__mark_task_complete', input: { summary: 'x' } },
        { type: 'tool_result', callId: 'c1', result: 'noted', isError: false },
      ],
    };
    render(<MessageView message={m} />);
    expect(screen.getByText('all done')).toBeInTheDocument();
    expect(screen.queryByText(/mark task complete/i)).not.toBeInTheDocument();
    expect(screen.queryByText('noted')).not.toBeInTheDocument();
  });
});
