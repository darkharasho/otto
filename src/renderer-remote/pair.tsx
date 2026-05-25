import { useState } from 'react';
import { useRemoteStore } from './store';
import { pair as doPair } from './wire';

// Accept either a full otto-pair:// URL or just the raw code.
function extractCode(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  try {
    // URL parser tolerates custom schemes via a placeholder origin.
    const u = new URL(trimmed.includes('://') ? trimmed.replace(/^otto-pair:/, 'http:') : `http://x/?code=${encodeURIComponent(trimmed)}`);
    const code = u.searchParams.get('code');
    return code ?? trimmed;
  } catch {
    return trimmed;
  }
}

function defaultDeviceLabel(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  return 'Browser';
}

export function Pair(): JSX.Element {
  const setToken = useRemoteStore((s) => s.setToken);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const code = extractCode(input);
    if (!code) { setError('Paste a pairing URL or code first.'); return; }
    setBusy(true); setError(null);
    try {
      const res = await doPair(code, defaultDeviceLabel());
      setToken(res.token);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full flex-col items-center justify-center px-6 py-12 bg-bg text-text">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold mb-2">Pair with Otto</h1>
        <p className="text-sm text-muted mb-6">
          On your desktop, open Otto&apos;s Settings → Remote and tap &ldquo;Pair iPhone&rdquo;.
          Paste the pairing URL or code below.
        </p>
        <form onSubmit={submit} className="space-y-4">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="otto-pair://… or paste code"
            className="w-full rounded-md bg-surface border border-border p-3 text-sm outline-none focus:border-accent"
            rows={3}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          {error && <div className="text-sm text-danger">{error}</div>}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-md bg-accent text-white font-medium py-3 disabled:opacity-50"
          >
            {busy ? 'Pairing…' : 'Pair'}
          </button>
        </form>
      </div>
    </div>
  );
}
