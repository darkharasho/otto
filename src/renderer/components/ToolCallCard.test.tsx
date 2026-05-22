import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToolCallCard } from './ToolCallCard';

describe('ToolCallCard', () => {
  it('shows tool name, status running when no result, and toggles details', async () => {
    render(<ToolCallCard name="echo" input={{ msg: 'hi' }} result={undefined} isError={false} />);
    expect(screen.getByText('echo')).toBeInTheDocument();
    expect(screen.getByText(/running/i)).toBeInTheDocument();
    expect(screen.queryByTestId('toolcall-details')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /echo/i }));
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
