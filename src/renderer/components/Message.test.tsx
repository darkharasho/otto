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

  it('renders an API error as an inline error card', () => {
    const m: Message = {
      ...baseAssistant,
      content: [{ type: 'text', text: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' }],
    };
    render(<MessageView message={m} />);
    expect(screen.getByText('The API is currently overloaded. Try again shortly.')).toBeInTheDocument();
    expect(screen.getByText('Show details')).toBeInTheDocument();
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

  it('shows a noop label when all counts are zero', () => {
    renderSystem({ facts: 0, playbooks: 0, antiPatterns: 0, heuristics: 0 });
    expect(screen.getByTestId('message-memory-update')).toBeInTheDocument();
    expect(screen.getByText('Memory checked — nothing new')).toBeInTheDocument();
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

describe('MessageView mark_task_complete visibility', () => {
  it('renders a legacy persisted mark_task_complete block as a quiet receipt', () => {
    // Sessions persisted before the outcome fold still carry these blocks.
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
    expect(screen.getByText('Task complete')).toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('MessageView user image-ref blocks', () => {
  it('renders an image-ref block in a user message via otto-user-image://', () => {
    const message: Message = {
      id: 'm1',
      sessionId: 's1',
      seq: 0,
      createdAt: 0,
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image-ref', id: 'r1', sessionId: 's1', path: '/tmp/r1.png', width: 10, height: 10, mimeType: 'image/png', source: 'user' },
      ],
    };
    render(<MessageView message={message} />);
    expect(screen.getByText('look')).toBeInTheDocument();
    const img = screen.getByRole('presentation', { hidden: true }) as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('otto-user-image://s1/r1.png');
  });
});

describe('MessageView click→capture merge', () => {
  const screenshotResult = {
    content: [
      { type: 'image-ref', id: 'shot1', sessionId: 's1', path: '/tmp/shot1.png', width: 200, height: 100, mimeType: 'image/png', source: 'screenshot' },
      { type: 'text', text: JSON.stringify({ path: '/tmp/shot1.png', width: 200, height: 100, monitors: [{}], tiles: [{ index: 0, x: 0, y: 0, w: 200, h: 100 }] }) },
    ],
  };

  function assistantWith(content: Message['content']): Message {
    return { ...baseAssistant, content };
  }

  it('merges a completed click into the preceding capture and suppresses its row', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    const m = assistantWith([
      { type: 'tool_use', callId: 'ss1', name: 'mcp__otto-tools__screenshot', input: {} },
      { type: 'tool_result', callId: 'ss1', result: screenshotResult, isError: false },
      { type: 'tool_use', callId: 'ck1', name: 'mcp__otto-tools__click', input: { x: 40, y: 60, button: 'left' } },
      { type: 'tool_result', callId: 'ck1', result: { content: [{ type: 'text', text: '{"ok":true}' }] }, isError: false },
    ]);
    const { container } = render(<MessageView message={m} />);
    // Only the screenshot card remains — the click folded into it as a marker.
    expect(container.querySelectorAll('[id^="activity-"]')).toHaveLength(1);
    expect(screen.queryByText('Click')).not.toBeInTheDocument();
    // Expanding the capture shows the reticle at the click point.
    await userEvent.click(screen.getByRole('button', { name: /screenshot/i }));
    expect(screen.getByTestId('image-marker')).toBeInTheDocument();
    expect(screen.getByText('click · 40, 60')).toBeInTheDocument();
  });

  it('keeps the click row when no capture precedes it', () => {
    const m = assistantWith([
      { type: 'tool_use', callId: 'ck1', name: 'mcp__otto-tools__click', input: { x: 40, y: 60, button: 'left' } },
      { type: 'tool_result', callId: 'ck1', result: { content: [{ type: 'text', text: '{"ok":true}' }] }, isError: false },
    ]);
    render(<MessageView message={m} />);
    expect(screen.getByText('Click')).toBeInTheDocument();
  });

  it('does not merge across intervening narration text', () => {
    const m = assistantWith([
      { type: 'tool_use', callId: 'ss1', name: 'mcp__otto-tools__screenshot', input: {} },
      { type: 'tool_result', callId: 'ss1', result: screenshotResult, isError: false },
      { type: 'text', text: 'Found the button, clicking it now.' },
      { type: 'tool_use', callId: 'ck1', name: 'mcp__otto-tools__click', input: { x: 40, y: 60, button: 'left' } },
      { type: 'tool_result', callId: 'ck1', result: { content: [{ type: 'text', text: '{"ok":true}' }] }, isError: false },
    ]);
    render(<MessageView message={m} />);
    expect(screen.getByText('Click')).toBeInTheDocument();
  });
});

describe('MessageView film-strip fold', () => {
  const shot = (id: string) => ({
    content: [
      { type: 'image-ref', id, sessionId: 's1', path: `/tmp/${id}.png`, width: 200, height: 100, mimeType: 'image/png', source: 'screenshot' },
      { type: 'text', text: JSON.stringify({ path: `/tmp/${id}.png`, width: 200, height: 100, monitors: [{}], tiles: [{ index: 0, x: 0, y: 0, w: 200, h: 100 }] }) },
    ],
  });
  const clickOk = { content: [{ type: 'text', text: '{"ok":true}' }] };

  function assistantWith(content: Message['content']): Message {
    return { ...baseAssistant, content };
  }

  const twoCapturesAndAClick: Message['content'] = [
    { type: 'tool_use', callId: 'ss1', name: 'mcp__otto-tools__screenshot', input: {} },
    { type: 'tool_result', callId: 'ss1', result: shot('shot1'), isError: false },
    { type: 'tool_use', callId: 'ss2', name: 'mcp__otto-tools__screenshot', input: {} },
    { type: 'tool_result', callId: 'ss2', result: shot('shot2'), isError: false },
    { type: 'tool_use', callId: 'ck1', name: 'mcp__otto-tools__click', input: { x: 40, y: 60, button: 'left' } },
    { type: 'tool_result', callId: 'ck1', result: clickOk, isError: false },
  ];

  it('collapses two settled captures (plus merged click) into one strip receipt', () => {
    const { container } = render(<MessageView message={assistantWith(twoCapturesAndAClick)} />);
    const strip = screen.getByTestId('film-strip');
    expect(strip).toHaveTextContent('Screen');
    expect(strip).toHaveTextContent('2 captures · 1 click');
    expect(strip.querySelectorAll('img')).toHaveLength(2); // thumbnails
    // The individual capture cards are folded away.
    expect(screen.queryByText('Screenshot')).not.toBeInTheDocument();
    expect(container.querySelectorAll('[id^="activity-"]')).toHaveLength(1);
  });

  it('expands to a gallery that keeps the merged click markers', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    render(<MessageView message={assistantWith(twoCapturesAndAClick)} />);
    await userEvent.click(screen.getByTestId('film-strip'));
    const gallery = screen.getByTestId('film-strip-gallery');
    expect(gallery.querySelectorAll('img')).toHaveLength(2);
    expect(screen.getByTestId('image-marker')).toBeInTheDocument();
    expect(screen.getByText('click · 40, 60')).toBeInTheDocument();
  });

  it('keeps individual capture cards while the turn is still streaming', () => {
    render(<MessageView message={assistantWith(twoCapturesAndAClick)} isStreamingTarget={true} />);
    expect(screen.queryByTestId('film-strip')).not.toBeInTheDocument();
    expect(screen.getAllByText('Screenshot').length).toBeGreaterThanOrEqual(2);
  });

  it('does not fold across intervening narration', () => {
    const m = assistantWith([
      { type: 'tool_use', callId: 'ss1', name: 'mcp__otto-tools__screenshot', input: {} },
      { type: 'tool_result', callId: 'ss1', result: shot('shot1'), isError: false },
      { type: 'text', text: 'Here is the first monitor.' },
      { type: 'tool_use', callId: 'ss2', name: 'mcp__otto-tools__screenshot', input: {} },
      { type: 'tool_result', callId: 'ss2', result: shot('shot2'), isError: false },
    ]);
    render(<MessageView message={m} />);
    expect(screen.queryByTestId('film-strip')).not.toBeInTheDocument();
  });
});

describe('MessageView outcome block', () => {
  it('renders the outcome card outside the activity spine', () => {
    const m: Message = {
      ...baseAssistant,
      content: [
        { type: 'tool_use', callId: 'c1', name: 'shell_exec', input: { command: 'balooctl suspend' } },
        { type: 'tool_result', callId: 'c1', result: { stdout: '', exitCode: 0 }, isError: false },
        {
          type: 'outcome',
          title: 'Stopped the frame hitches',
          durationMs: 12 * 60_000,
          toolCalls: 9,
          fix: 'balooctl suspend',
        },
        { type: 'text', text: 'All set.' },
      ],
    };
    render(<MessageView message={m} />);
    expect(screen.getByTestId('outcome-card')).toBeInTheDocument();
    expect(screen.getByText('Stopped the frame hitches')).toBeInTheDocument();
    expect(screen.getByText('12 minutes · 9 tool calls')).toBeInTheDocument();
    expect(screen.getByText('All set.')).toBeInTheDocument();
  });
});
