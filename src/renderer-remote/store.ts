import { create } from 'zustand';

const TOKEN_KEY = 'otto.remote.token';

function readToken(): string | null {
  // Prefer a token in the URL — iOS PWAs added to the Home Screen get an
  // isolated storage container, so Safari's localStorage doesn't carry over.
  // We thread the bearer through the URL after pairing so the launch URL
  // captured by "Add to Home Screen" hydrates the PWA's own localStorage.
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('t');
    if (fromUrl) {
      try { localStorage.setItem(TOKEN_KEY, fromUrl); } catch { /* private mode */ }
      return fromUrl;
    }
  } catch { /* SSR / no window */ }
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

function writeToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* private mode etc. */ }
}

interface RemoteStore {
  token: string | null;
  sessionId: string | null;
  autonomyMode: string | null;
  deviceLabel: string | null;
  setToken(t: string | null): void;
  setSessionId(s: string | null): void;
  setAutonomyMode(m: string | null): void;
  setDeviceLabel(l: string | null): void;
}

export const useRemoteStore = create<RemoteStore>((set) => ({
  token: readToken(),
  sessionId: null,
  autonomyMode: null,
  deviceLabel: null,
  setToken: (t) => { writeToken(t); set({ token: t }); },
  setSessionId: (s) => set({ sessionId: s }),
  setAutonomyMode: (m) => set({ autonomyMode: m }),
  setDeviceLabel: (l) => set({ deviceLabel: l }),
}));
