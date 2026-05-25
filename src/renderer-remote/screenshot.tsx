import { useEffect, useState } from 'react';
import { fetchScreenshot } from './wire';
import { useRemoteStore } from './store';

interface ScreenshotProps {
  id: string;
  signedUrl: string;
}

export function Screenshot(props: ScreenshotProps): JSX.Element {
  const token = useRemoteStore((s) => s.token);
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    let url: string | null = null;
    fetchScreenshot(token, props.signedUrl)
      .then((u) => { if (cancelled) { URL.revokeObjectURL(u); return; } url = u; setSrc(u); })
      .catch((e) => { if (!cancelled) setErr((e as Error).message); });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [token, props.signedUrl]);

  if (err) return <div className="text-xs text-danger">screenshot: {err}</div>;
  if (!src) return <div className="h-24 w-32 bg-surface border border-border rounded animate-pulse" />;

  return (
    <>
      <img
        src={src}
        alt={`screenshot ${props.id}`}
        onClick={() => setOpen(true)}
        className="max-w-[200px] rounded border border-border cursor-zoom-in"
      />
      {open && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
          onClick={() => setOpen(false)}
        >
          <img src={src} alt={`screenshot ${props.id}`} className="max-h-full max-w-full" />
        </div>
      )}
    </>
  );
}
