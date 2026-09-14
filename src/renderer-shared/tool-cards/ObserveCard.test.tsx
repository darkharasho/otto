import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ObserveCard } from './ObserveCard';
import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'observe' }>;

const T0 = new Date(2026, 8, 14, 14, 2, 0).getTime();

function doneView(over: Partial<View> = {}): View {
  return {
    kind: 'observe',
    label: 'frame times',
    unit: 'ms',
    threshold: 20,
    startedAt: T0,
    endedAt: T0 + 360_000,
    series: [12, 14, 38, 13, 12, 11],
    events: [{ t: T0 + 120_000, text: '38 ms — over 20 ms', level: 'alert' }],
    verdict: { ok: true, text: 'Resolved — 1 of 6 samples over 20 ms in 6m 0s' },
    ...over,
  };
}

describe('ObserveCard', () => {
  it('renders the sparkline with alert dots and the verdict row', () => {
    render(<ObserveCard view={doneView()} />);
    expect(screen.getByTestId('observe-sparkline')).toBeInTheDocument();
    expect(screen.getAllByTestId('observe-alert-dot')).toHaveLength(1); // only the 38ms sample
    expect(screen.getByTestId('observe-verdict')).toHaveTextContent('Resolved — 1 of 6 samples over 20 ms');
    expect(screen.getByText('6 samples · 1 alert')).toBeInTheDocument();
  });

  it('shows the watching state while the series is still live', () => {
    const v = doneView();
    const { endedAt: _e, verdict: _v, ...watching } = v;
    render(<ObserveCard view={watching as View} />);
    expect(screen.getByText(/watching · frame times/)).toBeInTheDocument();
    expect(screen.queryByTestId('observe-verdict')).not.toBeInTheDocument();
  });

  it('hides older events behind a show-all toggle', () => {
    const events = [1, 2, 3, 4, 5].map((n) => ({
      t: T0 + n * 1000,
      text: `event ${n}`,
      level: 'info' as const,
    }));
    render(<ObserveCard view={doneView({ events })} />);
    expect(screen.queryByText('event 1')).not.toBeInTheDocument();
    expect(screen.getByText('event 5')).toBeInTheDocument();
    fireEvent.click(screen.getByText('2 more · show all'));
    expect(screen.getByText('event 1')).toBeInTheDocument();
  });

  it('draws the before/after divider when the watch brackets a fix', () => {
    render(<ObserveCard view={doneView({ fixAt: T0 + 180_000 })} />);
    expect(screen.getByText('before')).toBeInTheDocument();
    expect(screen.getByText(/fix applied \d{2}:\d{2}/)).toBeInTheDocument();
  });

  it('marks alert dots below the threshold when alertWhen is below', () => {
    render(
      <ObserveCard
        view={doneView({ alertWhen: 'below', threshold: 12, series: [15, 11, 16] })}
      />
    );
    expect(screen.getAllByTestId('observe-alert-dot')).toHaveLength(1); // only the 11
  });
});
