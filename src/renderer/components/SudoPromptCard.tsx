import { useCallback, useEffect, useRef, useState } from 'react';
import type { ContentBlock } from '@shared/messages';
import { ipc } from '../ipc';

interface Props {
  block: Extract<ContentBlock, { type: 'sudo_prompt' }>;
}

export function SudoPromptCard({ block }: Props) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const pending = block.status === 'pending';

  // Autofocus when a fresh prompt (or retry) appears.
  useEffect(() => {
    if (pending) inputRef.current?.focus();
  }, [pending, block.promptId]);

  const submit = useCallback(
    async (pw: string | null) => {
      if (busy) return;
      setBusy(true);
      try {
        await ipc.invoke('autonomy.sudoPassword', { promptId: block.promptId, password: pw });
        setPassword('');
      } finally {
        setBusy(false);
      }
    },
    [block.promptId, busy]
  );

  const statusLine = (() => {
    switch (block.status) {
      case 'unlocked':
        return <span className="text-[11px] uppercase text-emerald-400">Elevated for this session</span>;
      case 'cancelled':
        return <span className="text-[11px] uppercase text-muted">Cancelled</span>;
      case 'failed':
        return <span className="text-[11px] uppercase text-danger">Authentication failed</span>;
      default:
        return null;
    }
  })();

  return (
    <div className="my-2 rounded-[11px] border border-amber-500/40 bg-gradient-to-b from-amber-500/[0.08] to-amber-500/[0.02] p-3 text-sm shadow-[0_0_24px_-8px_rgba(245,158,11,0.4)]">
      <div className="flex items-baseline justify-between mb-2">
        <div className="font-medium">
          <span>Administrator password</span>
          <span className="ml-2 inline-block text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-300 border border-amber-500/40">
            sudo
          </span>
        </div>
        {statusLine}
      </div>
      <div className="text-xs text-muted mb-2">
        Otto needs to run an elevated command. You&apos;ll only be asked once per session.
      </div>
      <pre className="text-xs font-mono bg-bg/60 rounded p-2 overflow-x-auto mb-2">{block.command}</pre>
      {block.error && pending && (
        <div className="text-xs text-danger mb-2">{block.error}</div>
      )}
      {pending ? (
        <form
          className="flex gap-2 items-center"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(password);
          }}
        >
          <input
            ref={inputRef}
            type="password"
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            disabled={busy}
            className="flex-1 rounded-md bg-bg/60 border border-border px-2 py-1 text-xs outline-none focus:border-amber-500/60 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={busy || password.length === 0}
            className="otto-send px-3 py-1 text-xs rounded-md hover:brightness-110 disabled:opacity-50"
          >
            Unlock
          </button>
          <button
            type="button"
            onClick={() => void submit(null)}
            disabled={busy}
            className="px-3 py-1 text-xs rounded-md border border-border text-muted hover:text-danger hover:border-danger/50 disabled:opacity-50"
          >
            Cancel
          </button>
        </form>
      ) : null}
    </div>
  );
}
