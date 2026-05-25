import { useEffect, useRef, useState } from 'react';
import { useRemoteStore } from './store';
import { pair as doPair } from './wire';

// Accept either a full pairing URL (http://host:port/?code=XYZ, or legacy
// otto-pair://...) or just the raw code. Strategy: if the input contains
// "code=", take the value after it up to "&" or end; otherwise treat the
// trimmed input as the code itself.
function extractCode(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  const idx = trimmed.indexOf('code=');
  if (idx === -1) return trimmed;
  const rest = trimmed.slice(idx + 'code='.length);
  const amp = rest.indexOf('&');
  const raw = amp === -1 ? rest : rest.slice(0, amp);
  try { return decodeURIComponent(raw); } catch { return raw; }
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

  // Detect a ?code=... in the URL on first mount; if present, auto-pair.
  const autoCode = (() => {
    try { return new URLSearchParams(window.location.search).get('code'); }
    catch { return null; }
  })();
  const [autoPairing, setAutoPairing] = useState<boolean>(!!autoCode);
  const autoTried = useRef(false);

  async function runPair(code: string): Promise<void> {
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

  useEffect(() => {
    if (autoTried.current) return;
    autoTried.current = true;
    if (!autoCode) return;
    void (async () => {
      try { await runPair(autoCode); }
      finally { setAutoPairing(false); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const code = extractCode(input);
    if (!code) { setError('Paste a pairing URL or code first.'); return; }
    await runPair(code);
  }

  if (autoPairing) {
    return (
      <div className="flex min-h-full flex-col items-center justify-center px-6 py-12 bg-bg text-text">
        <div className="w-full max-w-sm text-center">
          <h1 className="text-2xl font-semibold mb-2">Pairing…</h1>
          <p className="text-sm text-muted mb-6">Connecting this device to Otto.</p>
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-border border-t-accent" />
          {error && <div className="mt-6 text-sm text-danger">{error}</div>}
        </div>
      </div>
    );
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
          <label htmlFor="pair-input" className="block text-sm font-medium">
            Pairing URL or code
          </label>
          <textarea
            id="pair-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="http://…?code=XYZ or paste code"
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
