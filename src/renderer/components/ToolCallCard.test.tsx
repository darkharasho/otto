import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToolCallCard } from './ToolCallCard';

afterEach(() => {
  vi.useRealTimers();
});

describe('ToolCallCard — humanization', () => {
  it('shows humanized label and group for an MCP tool', () => {
    render(<ToolCallCard name="mcp__github__create_pull_request" input={{}} result={undefined} isError={false} />);
    expect(screen.getByText('Create Pull Request')).toBeInTheDocument();
    expect(screen.getByText(/GitHub/)).toBeInTheDocument();
  });

  it('shows an inline summary line for shell_exec', () => {
    render(<ToolCallCard name="shell_exec" input={{ command: 'pnpm test' }} result={undefined} isError={false} />);
    expect(screen.getAllByText(/pnpm test/).length).toBeGreaterThanOrEqual(1);
  });
});

describe('ToolCallCard — lifecycle', () => {
  it('is expanded with a running pill while the call is in flight', () => {
    render(<ToolCallCard name="echo" input={{}} result={undefined} isError={false} />);
    expect(screen.getByText(/running/i)).toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
  });

  it('starts settled as a receipt when mounted with a result (history)', () => {
    render(<ToolCallCard name="echo" input={{}} result="hi" isError={false} />);
    const receipt = screen.getByRole('button');
    expect(receipt).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('echo')).toBeInTheDocument();
    expect(screen.queryByTestId('toolcall-details')).not.toBeInTheDocument();
  });

  it('clicking a receipt re-expands to the full card with the done pill', async () => {
    render(<ToolCallCard name="echo" input={{}} result="hi" isError={false} />);
    await userEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/done/i)).toBeInTheDocument();
  });

  it('keeps the error reason on the settled receipt', () => {
    render(<ToolCallCard name="echo" input={{}} result="oops, it broke" isError={true} />);
    expect(screen.getByText(/oops, it broke/)).toBeInTheDocument();
  });

  it('stays expanded when done mid-turn, settles when the turn ends', () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <ToolCallCard name="shell_exec" input={{ command: 'ls' }} result={undefined} isError={false} turnActive={true} />
    );
    rerender(
      <ToolCallCard name="shell_exec" input={{ command: 'ls' }} result={{ stdout: 'a\n', exitCode: 0 }} isError={false} turnActive={true} />
    );
    expect(screen.getByText(/done/i)).toBeInTheDocument();
    rerender(
      <ToolCallCard name="shell_exec" input={{ command: 'ls' }} result={{ stdout: 'a\n', exitCode: 0 }} isError={false} turnActive={false} />
    );
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.queryByText(/done/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  });

  it('settles 30s after finishing even while the turn is still active', () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <ToolCallCard name="shell_exec" input={{ command: 'ls' }} result={undefined} isError={false} turnActive={true} />
    );
    rerender(
      <ToolCallCard name="shell_exec" input={{ command: 'ls' }} result={{ stdout: 'a\n', exitCode: 0 }} isError={false} turnActive={true} />
    );
    act(() => { vi.advanceTimersByTime(31_000); });
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  });

  it('renders quiet tools as receipts even while running', () => {
    render(<ToolCallCard name="Read" input={{ file_path: '/tmp/a.ts' }} result={undefined} isError={false} />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('/tmp/a.ts')).toBeInTheDocument();
  });

  it('shows a capture placeholder while a screenshot is in flight', () => {
    render(<ToolCallCard name="screenshot" input={{}} result={undefined} isError={false} />);
    expect(screen.getByText(/nothing leaves this machine/i)).toBeInTheDocument();
  });

  it('fills the running terminal with streamed partial output', () => {
    render(
      <ToolCallCard
        name="shell_exec"
        input={{ command: 'pnpm build' }}
        result={undefined}
        isError={false}
        partialOutput={{ stdout: 'compiling main…\nbundling renderer…\n', stderr: '' }}
      />
    );
    expect(screen.getByText(/compiling main/)).toBeInTheDocument();
    expect(screen.getByText(/bundling renderer/)).toBeInTheDocument();
    expect(screen.getByText(/streaming…/)).toBeInTheDocument();
  });
});

describe('ToolCallCard — agent annotations', () => {
  it('prefers the agent takeaway on the settled receipt', () => {
    render(
      <ToolCallCard
        name="shell_exec"
        input={{ command: 'iostat -x 1 3' }}
        result={{ stdout: 'lots of numbers\n', exitCode: 0, durationMs: 3100 }}
        isError={false}
        takeaway="indexer reading 212 MB/s during the hitch"
      />
    );
    expect(screen.getByText('indexer reading 212 MB/s during the hitch')).toBeInTheDocument();
    expect(screen.queryByText(/exit 0/)).not.toBeInTheDocument();
  });

  it('agent why beats the stderr classification in the Why row', async () => {
    render(
      <ToolCallCard
        name="shell_exec"
        input={{ command: 'cp big.iso /mnt/usb/' }}
        result={{ stdout: '', stderr: 'cp: error writing', exitCode: 1 }}
        isError={false}
        why="The USB stick is full — freeing space, then retrying."
      />
    );
    await userEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/freeing space, then retrying/)).toBeInTheDocument();
  });

  it('draws click markers on a merged capture', async () => {
    const result = {
      content: [
        { type: 'image-ref', id: 'shot1', sessionId: 's1', path: '/tmp/s.png', width: 200, height: 100, mimeType: 'image/png', source: 'screenshot' },
        { type: 'text', text: JSON.stringify({ tiles: [{ index: 0, x: 0, y: 0, w: 200, h: 100 }] }) },
      ],
    };
    render(
      <ToolCallCard
        name="screenshot"
        input={{}}
        result={result}
        isError={false}
        markers={[{ x: 40, y: 60, label: 'click · 40, 60' }]}
      />
    );
    await userEvent.click(screen.getByRole('button'));
    expect(screen.getByTestId('image-marker')).toBeInTheDocument();
    expect(screen.getByText('click · 40, 60')).toBeInTheDocument();
  });
});

describe('ToolCallCard — observe', () => {
  const base = {
    kind: 'observe',
    label: 'frame times',
    unit: 'ms',
    threshold: 20,
    alertWhen: 'above',
    startedAt: Date.now() - 65_000,
    series: [12, 38, 14],
    events: [{ t: Date.now() - 30_000, text: '38 ms — over 20 ms', level: 'alert' }],
  };

  it('renders the live chart from the partial snapshot while running', () => {
    render(
      <ToolCallCard
        name="mcp__otto-tools__observe"
        input={{ label: 'frame times', command: 'cat /tmp/frametime', unit: 'ms' }}
        result={undefined}
        isError={false}
        partialSnapshot={base}
      />
    );
    expect(screen.getByText(/running/i)).toBeInTheDocument();
    expect(screen.getByTestId('observe-sparkline')).toBeInTheDocument();
    expect(screen.getByText(/watching · frame times/)).toBeInTheDocument();
    expect(screen.queryByTestId('observe-verdict')).not.toBeInTheDocument();
  });

  it('uses the verdict as the settled receipt note', () => {
    render(
      <ToolCallCard
        name="mcp__otto-tools__observe"
        input={{ label: 'frame times', command: 'cat /tmp/frametime', unit: 'ms' }}
        result={{
          ...base,
          endedAt: Date.now(),
          verdict: { ok: true, text: 'Resolved — 1 of 3 samples over 20 ms in 1m 5s' },
        }}
        isError={false}
      />
    );
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Resolved — 1 of 3 samples over 20 ms in 1m 5s')).toBeInTheDocument();
  });
});

describe('ToolCallCard — result rendering', () => {
  it('renders an <img> for the built-in screenshot tool', async () => {
    render(
      <ToolCallCard
        name="screenshot"
        input={{}}
        result={{ path: '/tmp/a.png', width: 1920, height: 1080 }}
        isError={false}
      />,
    );
    await userEvent.click(screen.getAllByRole('button')[0]!);
    expect(screen.getAllByRole('img')[0]!).toHaveAttribute('src', 'file:///tmp/a.png');
  });

  it('renders an <img> for an MCP tool returning a base64 data URL', async () => {
    render(
      <ToolCallCard
        name="mcp__chrome-devtools-mcp__take_screenshot"
        input={{}}
        result="data:image/png;base64,AAAA"
        isError={false}
      />,
    );
    await userEvent.click(screen.getAllByRole('button')[0]!);
    expect(screen.getAllByRole('img')[0]!).toHaveAttribute('src', 'data:image/png;base64,AAAA');
  });

  it('renders shell stdout as a terminal block with the exit footer', async () => {
    render(<ToolCallCard name="shell_exec" input={{ command: 'echo hi' }} result={{ stdout: 'hi\n', exitCode: 0 }} isError={false} />);
    await userEvent.click(screen.getAllByRole('button')[0]!);
    expect(screen.getByText('hi')).toBeInTheDocument();
    expect(screen.getByText(/exit 0/)).toBeInTheDocument();
    expect(screen.getAllByText(/echo hi/).length).toBeGreaterThanOrEqual(1);
  });

  it('does not render INPUT subheader for shell terminal results', async () => {
    render(<ToolCallCard name="shell_exec" input={{ command: 'echo hi' }} result={{ stdout: 'hi\n', exitCode: 0 }} isError={false} />);
    await userEvent.click(screen.getAllByRole('button')[0]!);
    expect(screen.queryByText('Input')).not.toBeInTheDocument();
    expect(screen.queryByText('Result')).not.toBeInTheDocument();
  });

  it('hides INPUT block when input is an empty object', async () => {
    render(<ToolCallCard name="mcp__otto-tools__get_cursor_position" input={{}} result={{ x: 100, y: 200 }} isError={false} />);
    await userEvent.click(screen.getAllByRole('button')[0]!);
    expect(screen.queryByText('Input')).not.toBeInTheDocument();
  });
});
