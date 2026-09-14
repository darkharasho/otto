import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TerminalCard } from './TerminalCard';
import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'terminal' }>;

function doneView(over: Partial<View> = {}): View {
  return { kind: 'terminal', command: 'journalctl -b', exitCode: 0, ...over };
}

describe('TerminalCard — fold with finding lines', () => {
  // 20 lines; line 8 carries the finding. Folded keeps line 1 (first),
  // line 8 (finding), lines 17–20 (tail), and hides the two quiet runs.
  const lines = Array.from({ length: 20 }, (_, i) =>
    i === 7 ? 'baloo_file: ERROR io timeout during index sweep' : `quiet line ${i + 1}`
  );
  const stdout = lines.join('\n') + '\n';

  it('keeps the finding line visible and red-tinted while folded', () => {
    const { container } = render(<TerminalCard view={doneView({ stdout })} />);
    const finding = screen.getByTestId('terminal-finding');
    expect(finding).toHaveTextContent('ERROR io timeout');
    expect(finding.className).toContain('#ff8f8f');
    // Two quiet runs: lines 2–7 (6 hidden) and 9–16 (8 hidden).
    expect(screen.getByText('— 6 quiet lines hidden —')).toBeInTheDocument();
    expect(screen.getByText('— 8 quiet lines hidden —')).toBeInTheDocument();
    expect(container.textContent).not.toContain('quiet line 3');
    expect(container.textContent).toContain('quiet line 20');
  });

  it('unfolds everything when a hidden-run row is clicked', () => {
    const { container } = render(<TerminalCard view={doneView({ stdout })} />);
    fireEvent.click(screen.getByText('— 6 quiet lines hidden —'));
    expect(container.textContent).toContain('quiet line 3');
    expect(container.textContent).toContain('quiet line 12');
    expect(screen.queryByText(/quiet lines hidden/)).not.toBeInTheDocument();
    // The finding keeps its tint after unfolding.
    expect(screen.getByTestId('terminal-finding')).toBeInTheDocument();
  });

  it('does not flag plural counters like "0 errors" as findings', () => {
    render(<TerminalCard view={doneView({ stdout: 'compiled 14 files\n0 errors\n' })} />);
    expect(screen.queryByTestId('terminal-finding')).not.toBeInTheDocument();
  });
});

describe('TerminalCard — stop button', () => {
  it('shows Stop while streaming and forwards the click', () => {
    const onStop = vi.fn();
    render(
      <TerminalCard
        view={{ kind: 'terminal', command: 'sleep 600', stdout: 'tick\n', streaming: true }}
        onStop={onStop}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('renders no Stop button without a handler or once settled', () => {
    const { rerender } = render(
      <TerminalCard view={{ kind: 'terminal', command: 'sleep 600', streaming: true }} />
    );
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    rerender(
      <TerminalCard
        view={{ kind: 'terminal', command: 'sleep 600', stdout: '', exitCode: 143 }}
        onStop={vi.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
  });
});
