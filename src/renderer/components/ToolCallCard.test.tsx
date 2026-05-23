import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToolCallCard } from './ToolCallCard';

describe('ToolCallCard', () => {
  it('shows tool name, status running when no result, and toggles details open', async () => {
    render(<ToolCallCard name="echo" input={{ msg: 'hi' }} result={undefined} isError={false} />);
    expect(screen.getByText('echo')).toBeInTheDocument();
    expect(screen.getByText(/running/i)).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: /echo/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('toolcall-details')).toBeInTheDocument();
  });

  it('shows done with result', () => {
    render(<ToolCallCard name="echo" input={{ msg: 'hi' }} result="hi" isError={false} />);
    expect(screen.getByText(/done/i)).toBeInTheDocument();
  });

  it('shows error status when isError', () => {
    render(<ToolCallCard name="echo" input={{ msg: 'hi' }} result="oops" isError={true} />);
    expect(screen.getByText(/error/i)).toBeInTheDocument();
  });
});

describe('ToolCallCard: screenshot rendering', () => {
  it('renders an <img> with file:// URL when name === "screenshot" and result has path', async () => {
    render(
      <ToolCallCard
        name="screenshot"
        input={{}}
        result={{
          path: '/tmp/otto-screenshots/sess/abc.png',
          width: 1920,
          height: 1080,
          monitors: [{ id: '1', x: 0, y: 0, w: 1920, h: 1080, scale: 1 }],
        }}
        isError={false}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: /screenshot/i }));
    const img = screen.getByRole('img');
    expect(img).toHaveAttribute('src', 'file:///tmp/otto-screenshots/sess/abc.png');
  });

  it('does not render an <img> for non-screenshot tools', async () => {
    render(
      <ToolCallCard name="shell_exec" input={{}} result={{ stdout: 'hi' }} isError={false} />
    );
    await userEvent.click(screen.getByRole('button', { name: /shell_exec/i }));
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('does not render an <img> for screenshot results without a path', async () => {
    render(<ToolCallCard name="screenshot" input={{}} result={{}} isError={false} />);
    await userEvent.click(screen.getByRole('button', { name: /screenshot/i }));
    expect(screen.queryByRole('img')).toBeNull();
  });
});
