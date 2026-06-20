import { useState } from 'react';

interface SudoPromptCardProps {
  command: string;
  error?: string;
  onResolve(password: string | null): void;
}

export function SudoPromptCard(props: SudoPromptCardProps): JSX.Element {
  const [password, setPassword] = useState('');

  return (
    <div className="otto-elevated rounded-[10px] p-3 space-y-2 border border-amber-500/40">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-sm">Administrator password</span>
        <span className="text-xs text-white rounded px-2 py-0.5 bg-amber-600">sudo</span>
      </div>
      <div className="text-sm text-muted">
        Otto needs to run an elevated command. You&apos;ll only be asked once per session.
      </div>
      <div className="text-xs text-muted font-mono line-clamp-3 whitespace-pre-wrap break-words bg-bg/60 rounded p-2">
        {props.command}
      </div>
      {props.error && <div className="text-xs text-red-400">{props.error}</div>}
      <form
        className="flex gap-2 pt-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (password.length > 0) props.onResolve(password);
        }}
      >
        <input
          type="password"
          inputMode="text"
          autoComplete="off"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="flex-1 min-w-0 rounded-md border border-border bg-bg/60 px-2 py-2 text-sm outline-none focus:border-amber-500/60"
        />
        <button
          type="button"
          onClick={() => props.onResolve(null)}
          className="rounded-md border border-border bg-bg/60 text-muted px-3 py-2 text-sm font-medium hover:text-text"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={password.length === 0}
          className="otto-send rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50"
        >
          Unlock
        </button>
      </form>
    </div>
  );
}
