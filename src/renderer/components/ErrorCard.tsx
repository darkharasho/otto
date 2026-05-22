import type { StructuredError } from '@shared/ipc-contract';

interface Props {
  error: StructuredError;
  onRetry?: () => void;
}

export function ErrorCard({ error, onRetry }: Props) {
  const headline =
    error.kind === 'auth-missing'
      ? 'Sign in to Claude Code, then retry.'
      : error.message;

  return (
    <div className="my-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm">
      <div className="text-danger font-medium">{headline}</div>
      {error.kind !== 'auth-missing' && (
        <div className="text-xs text-muted mt-1 font-mono">{error.message}</div>
      )}
      {error.retryable && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 text-xs text-accent hover:underline"
        >
          Retry
        </button>
      )}
    </div>
  );
}
