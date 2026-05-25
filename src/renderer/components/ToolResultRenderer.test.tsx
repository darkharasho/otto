import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ToolResultRenderer } from './ToolResultRenderer';

describe('ToolResultRenderer', () => {
  it('renders an <img> for image kind', () => {
    render(<ToolResultRenderer view={{ kind: 'image', src: 'data:image/png;base64,AAAA' }} />);
    const img = screen.getByRole('img');
    expect(img).toHaveAttribute('src', 'data:image/png;base64,AAAA');
  });

  it('renders stdout and exit code for terminal kind', () => {
    render(<ToolResultRenderer view={{ kind: 'terminal', stdout: 'hello', exitCode: 0 }} />);
    expect(screen.getByText('hello')).toBeInTheDocument();
    expect(screen.getByText(/exited 0/i)).toBeInTheDocument();
  });

  it('renders kv entries as a definition list', () => {
    render(<ToolResultRenderer view={{ kind: 'kv', entries: [['number', '287'], ['state', 'open']] }} />);
    expect(screen.getByText('number')).toBeInTheDocument();
    expect(screen.getByText('287')).toBeInTheDocument();
  });

  it('renders error text for error kind', () => {
    render(<ToolResultRenderer view={{ kind: 'error', text: 'nope' }} />);
    expect(screen.getByText('nope')).toBeInTheDocument();
  });

  it('renders nothing for empty kind', () => {
    const { container } = render(<ToolResultRenderer view={{ kind: 'empty' }} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a <pre> JSON dump for json kind', () => {
    render(<ToolResultRenderer view={{ kind: 'json', value: { a: 1 } }} />);
    expect(screen.getByText(/"a": 1/)).toBeInTheDocument();
  });
});
