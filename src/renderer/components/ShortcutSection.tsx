import { useEffect, useState } from 'react';
import { ipc } from '../ipc';
import { Section } from './SettingsControls';
import type { ShortcutInfoView } from '@shared/ipc-contract';

export function ShortcutSection() {
  const [info, setInfo] = useState<ShortcutInfoView | null>(null);
  const [copied, setCopied] = useState<'prod' | 'dev' | null>(null);
  const [launchErr, setLaunchErr] = useState<string | null>(null);

  useEffect(() => {
    void ipc.invoke('shortcut.info', undefined).then(setInfo);
  }, []);

  if (!info) {
    return (
      <Section title="Keyboard shortcut">
        <div className="text-xs text-muted">Loading…</div>
      </Section>
    );
  }

  const copy = (which: 'prod' | 'dev', cmd: string) => {
    void navigator.clipboard.writeText(cmd);
    setCopied(which);
    window.setTimeout(() => setCopied((c) => (c === which ? null : c)), 1400);
  };

  return (
    <Section title="Keyboard shortcut" description={describeMechanism(info)}>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm text-text">Default chord</div>
            <div className="text-[11px] text-muted mt-0.5">
              {info.mechanism === 'global-shortcut'
                ? 'Registered for this session.'
                : 'Bind this in your desktop keyboard settings using the command below.'}
            </div>
          </div>
          <code className="px-2 py-1 rounded bg-bg/60 border border-border text-xs text-text">
            {info.recommendedChord}
          </code>
        </div>

        <StatusRow info={info} />

        {info.mechanism !== 'global-shortcut' && (
          <>
            <CommandRow
              label={info.commands.dev ? 'Prod toggle command' : 'Toggle command'}
              command={info.commands.prod}
              copied={copied === 'prod'}
              onCopy={() => copy('prod', info.commands.prod)}
            />
            {info.commands.dev && (
              <CommandRow
                label="Dev toggle command"
                command={info.commands.dev}
                copied={copied === 'dev'}
                onCopy={() => copy('dev', info.commands.dev!)}
              />
            )}
          </>
        )}

        {hasSettingsLauncher(info) && (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={async () => {
                setLaunchErr(null);
                const r = (await ipc.invoke('shortcut.openKeyboardSettings', undefined)) as {
                  launched: boolean;
                };
                if (!r.launched) {
                  setLaunchErr(`Couldn't open keyboard settings for ${info.desktopEnv}.`);
                }
              }}
              className="text-xs px-2.5 py-1 rounded-md bg-bg/60 border border-border text-text hover:border-accent/60"
            >
              Open keyboard settings
            </button>
            {launchErr && <span className="text-[11px] text-danger">{launchErr}</span>}
          </div>
        )}
      </div>
    </Section>
  );
}

function StatusRow({ info }: { info: ShortcutInfoView }) {
  if (info.registered && info.mechanism === 'global-shortcut') {
    return (
      <div className="flex items-center gap-2 text-[11px]">
        <Dot className="text-accent" />
        <span className="text-text">Registered for this session</span>
      </div>
    );
  }
  if (info.mechanism === 'external-toggle') {
    return (
      <div className="flex items-center gap-2 text-[11px]">
        <Dot className="text-muted" />
        <span className="text-text">Manual binding required on Wayland</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <Dot className="text-danger" />
      <span className="text-text">Not registered</span>
    </div>
  );
}

function CommandRow({
  label,
  command,
  copied,
  onCopy,
}: {
  label: string;
  command: string;
  copied: boolean;
  onCopy(): void;
}) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] text-muted">{label}</div>
      <div className="flex items-stretch gap-2">
        <code className="flex-1 min-w-0 truncate px-2 py-1.5 rounded-md bg-bg/60 border border-border text-xs text-text">
          {command}
        </code>
        <button
          type="button"
          onClick={onCopy}
          className={[
            'text-xs px-2.5 py-1.5 rounded-md font-medium transition-colors flex-shrink-0',
            copied ? 'bg-accent/20 text-accent' : 'bg-bg/60 border border-border text-text hover:border-accent/60',
          ].join(' ')}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

function Dot({ className }: { className: string }) {
  return <span className={`inline-block w-1.5 h-1.5 rounded-full bg-current ${className}`} />;
}

function describeMechanism(info: ShortcutInfoView): string {
  if (info.mechanism === 'global-shortcut') {
    return 'Global hotkey is held for this session.';
  }
  if (info.mechanism === 'external-toggle') {
    return 'On Wayland, bind a desktop keyboard shortcut to the command below.';
  }
  return 'No global hotkey is active. Use the command below to bind one.';
}

function hasSettingsLauncher(info: ShortcutInfoView): boolean {
  return (
    info.desktopEnv === 'kde' ||
    info.desktopEnv === 'gnome' ||
    info.desktopEnv === 'cinnamon' ||
    info.desktopEnv === 'mate' ||
    info.desktopEnv === 'xfce'
  );
}
