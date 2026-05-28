import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToolCallCard } from './ToolCallCard';

describe('ToolCallCard — humanization', () => {
  it('shows humanized label and group for an MCP tool', () => {
    render(<ToolCallCard name="mcp__github__create_pull_request" input={{}} result={undefined} isError={false} />);
    expect(screen.getByText('Create Pull Request')).toBeInTheDocument();
    expect(screen.getByText('GitHub')).toBeInTheDocument();
  });

  it('shows an inline summary line for shell_exec', () => {
    render(<ToolCallCard name="shell_exec" input={{ command: 'pnpm test' }} result={undefined} isError={false} />);
    expect(screen.getByText('pnpm test')).toBeInTheDocument();
  });
});

describe('ToolCallCard — status', () => {
  it('shows running when no result', () => {
    render(<ToolCallCard name="echo" input={{}} result={undefined} isError={false} />);
    expect(screen.getByText(/running/i)).toBeInTheDocument();
  });
  it('shows done with result', () => {
    render(<ToolCallCard name="echo" input={{}} result="hi" isError={false} />);
    expect(screen.getByText(/done/i)).toBeInTheDocument();
  });
  it('shows error status when isError', () => {
    render(<ToolCallCard name="echo" input={{}} result="oops" isError={true} />);
    expect(screen.getByText(/error/i)).toBeInTheDocument();
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

  it('renders shell stdout as a terminal block', async () => {
    render(<ToolCallCard name="shell_exec" input={{ command: 'echo hi' }} result={{ stdout: 'hi\n', exitCode: 0 }} isError={false} />);
    await userEvent.click(screen.getAllByRole('button')[0]!);
    expect(screen.getByText('hi')).toBeInTheDocument();
    expect(screen.getByText(/exited 0/)).toBeInTheDocument();
  });
});
