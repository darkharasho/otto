import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { ipc } from '../../ipc';
import type { PairingCodePayload } from '@shared/ipc-contract';

interface Props {
  initialDeviceCount: number;
  onClose: () => void;
  onPaired: () => void;
}

export function PairMobileModal({ initialDeviceCount, onClose, onPaired }: Props) {
  const [payload, setPayload] = useState<PairingCodePayload | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number>(0);
  const [paired, setPaired] = useState(false);
  const [copied, setCopied] = useState(false);
  const closedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await ipc.invoke('remote:mintPairingCode', undefined);
        if (cancelled) return;
        setPayload(p);
        try {
          const data = await QRCode.toDataURL(p.url);
          if (!cancelled) setQrDataUrl(data);
        } catch (e) {
          if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Countdown tick
  useEffect(() => {
    if (!payload) return;
    const tick = () => {
      setSecondsLeft(Math.max(0, Math.ceil((payload.expiresAt - Date.now()) / 1000)));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [payload]);

  // Poll for new device
  useEffect(() => {
    if (paired) return;
    const id = setInterval(async () => {
      try {
        const devs = await ipc.invoke('remote:listDevices', undefined);
        if (devs.length > initialDeviceCount && !closedRef.current) {
          setPaired(true);
          onPaired();
          setTimeout(() => {
            if (!closedRef.current) {
              closedRef.current = true;
              onClose();
            }
          }, 1000);
        }
      } catch {
        // ignore transient errors
      }
    }, 3000);
    return () => clearInterval(id);
  }, [paired, initialDeviceCount, onPaired, onClose]);

  function close() {
    if (closedRef.current) return;
    closedRef.current = true;
    onClose();
  }

  async function copyUrl() {
    if (!payload) return;
    try {
      await navigator.clipboard.writeText(payload.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-surface border border-border shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="text-sm font-semibold text-text">Pair a new device</div>
          <button
            type="button"
            aria-label="Close"
            onClick={close}
            className="text-muted hover:text-text rounded p-1"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-4 space-y-3">
          {paired ? (
            <div className="text-sm text-accent text-center py-8">Paired!</div>
          ) : err ? (
            <div className="text-xs text-danger">Failed to start pairing: {err}</div>
          ) : !payload || !qrDataUrl ? (
            <div className="text-sm text-muted text-center py-8">Generating code…</div>
          ) : (
            <>
              <div className="flex items-center justify-center bg-white rounded-lg p-3">
                <img src={qrDataUrl} alt="Pairing QR code" className="w-48 h-48" />
              </div>
              <div className="text-xs text-muted">
                Scan with your phone, or open this URL on the device:
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 px-2 py-1 text-[11px] rounded-md bg-bg/60 border border-border text-text truncate">
                  {payload.url}
                </code>
                <button
                  type="button"
                  onClick={copyUrl}
                  className="px-2 py-1 text-xs rounded-md bg-bg/60 border border-border text-text hover:border-accent/60"
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <div className="text-xs text-muted text-center">
                Expires in {secondsLeft}s
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
