import { useState } from 'react';
import type { ErrorKind, StructuredError } from '@shared/ipc-contract';

interface Props {
  error: StructuredError;
  onRetry?: () => void;
}

const headlines: Record<ErrorKind, string> = {
  'auth-missing': 'Sign in to Claude Code, then retry.',
  'rate-limit': 'Rate limited — please wait a moment and retry.',
  'overloaded': 'The API is currently overloaded. Try again shortly.',
  'invalid-request': 'The request was invalid.',
  'network': 'Could not reach the API. Check your internet connection.',
  'sdk-stream': 'Something went wrong.',
  'cancelled': 'Cancelled.',
  'internal': 'An internal error occurred.',
};

export function ErrorCard({ error, onRetry }: Props) {
  const [showDetails, setShowDetails] = useState(false);
  const headline = headlines[error.kind];

  return (
    <div className="my-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm">
      <div className="text-danger font-medium">{headline}</div>
      {error.message && error.message !== headline && (
        <>
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            className="mt-1 text-xs text-muted hover:underline"
          >
            {showDetails ? 'Hide details' : 'Show details'}
          </button>
          {showDetails && (
            <div className="text-xs text-muted mt-1 font-mono whitespace-pre-wrap break-all">
              {error.message}
            </div>
          )}
        </>
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

/** Detect API error patterns in raw text and return a friendly headline + kind,
 *  or null if the text doesn't look like an error. */
export function classifyErrorText(text: string): { headline: string; kind: ErrorKind } | null {
  const lower = text.toLowerCase();
  if (lower.includes('rate limit') || lower.includes('rate_limit') || lower.includes('429'))
    return { headline: headlines['rate-limit'], kind: 'rate-limit' };
  if (lower.includes('overloaded') || lower.includes('529') || lower.includes('503'))
    return { headline: headlines['overloaded'], kind: 'overloaded' };
  if (lower.includes('unauthorized') || lower.includes('401') || lower.includes('authentication'))
    return { headline: headlines['auth-missing'], kind: 'auth-missing' };
  if (lower.includes('invalid request') || lower.includes('invalid_request') || lower.includes('400'))
    return { headline: headlines['invalid-request'], kind: 'invalid-request' };
  if (lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('fetch failed'))
    return { headline: headlines['network'], kind: 'network' };
  // Generic API error patterns
  if (lower.includes('"type":"error"') || lower.includes('error code:') || /^\s*\{.*"error"/.test(lower))
    return { headline: headlines['sdk-stream'], kind: 'sdk-stream' };
  return null;
}

/** Inline error card for use inside message bubbles. */
export function InlineErrorCard({ headline, details }: { headline: string; details?: string }) {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <div className="my-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm">
      <div className="text-danger font-medium">{headline}</div>
      {details && (
        <>
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            className="mt-1 text-xs text-muted hover:underline"
          >
            {showDetails ? 'Hide details' : 'Show details'}
          </button>
          {showDetails && (
            <div className="text-xs text-muted mt-1 font-mono whitespace-pre-wrap break-all">
              {details}
            </div>
          )}
        </>
      )}
    </div>
  );
}
