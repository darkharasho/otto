import dbus, { Variant, type MessageBus } from 'dbus-next';
import { screen } from 'electron';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { logger } from '../logger';

export type MouseButton = 'left' | 'right' | 'middle';

export interface InputHandle {
  move(x: number, y: number): Promise<void>;
  click(x: number, y: number, button: MouseButton): Promise<void>;
  doubleClick(x: number, y: number, button: MouseButton): Promise<void>;
  drag(x1: number, y1: number, x2: number, y2: number, button: MouseButton): Promise<void>;
  scroll(dx: number, dy: number, x?: number, y?: number): Promise<void>;
}

export interface PortalDeps {
  /** Directory holding `remote-desktop-token`. */
  configDir: string;
  /** Inject a bus for tests; real callers omit and we connect to the session bus. */
  bus?: MessageBus;
  /** Inject the cursor reader for tests. Defaults to Electron's screen API. */
  getCursor?: () => { x: number; y: number };
}

const PORTAL_SERVICE = 'org.freedesktop.portal.Desktop';
const PORTAL_OBJECT = '/org/freedesktop/portal/desktop';
const REMOTE_DESKTOP_IFACE = 'org.freedesktop.portal.RemoteDesktop';
const REQUEST_IFACE = 'org.freedesktop.portal.Request';

const BTN_CODE: Record<MouseButton, number> = {
  left: 0x110,
  right: 0x111,
  middle: 0x112,
};
const SCROLL_NOTCH = 10;
const DOUBLE_CLICK_DELAY_MS = 50;

type AnyIface = {
  call?: (member: string, ...args: unknown[]) => Promise<unknown>;
  on(event: string, handler: (...args: unknown[]) => void): void;
  off?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
  [member: string]: unknown;
};

type VariantLike = { value: unknown };
function v(signature: string, value: unknown): VariantLike {
  // dbus-next's Variant marshals correctly on the real session bus; the
  // plain `{ value }` fallback only exists so the test stubs (which read
  // `.value` directly) don't need to import dbus-next.
  if (typeof Variant === 'function') return new Variant(signature, value);
  return { value };
}
void dbus;

function randomToken(): string {
  return `t${randomBytes(8).toString('hex')}`;
}

/**
 * Bridge invocation for both real dbus-next ClientInterface (which exposes
 * each method as a generated property) and our test stub (which exposes a
 * generic `call(member, ...args)` method).
 */
async function callMember(iface: AnyIface, member: string, ...args: unknown[]): Promise<unknown> {
  const direct = iface[member];
  if (typeof direct === 'function') {
    return (direct as (...a: unknown[]) => unknown).call(iface, ...args) as Promise<unknown>;
  }
  if (typeof iface.call === 'function') {
    return iface.call(member, ...args);
  }
  throw new Error(`dbus interface missing member: ${member}`);
}

function offListener(iface: AnyIface, event: string, handler: (...args: unknown[]) => void): void {
  if (typeof iface.off === 'function') {
    iface.off(event, handler);
    return;
  }
  if (typeof iface.removeListener === 'function') {
    iface.removeListener(event, handler);
  }
}

export function createPortalInput(deps: PortalDeps): InputHandle {
  const tokenPath = path.join(deps.configDir, 'remote-desktop-token');
  const getCursor = deps.getCursor ?? (() => screen.getCursorScreenPoint());

  let busRef: MessageBus | null = deps.bus ?? null;
  let sessionPath: string | null = null;
  let handshakePromise: Promise<void> | null = null;
  let tail: Promise<void> = Promise.resolve();

  async function getBus(): Promise<MessageBus> {
    if (busRef) return busRef;
    busRef = dbus.sessionBus();
    return busRef;
  }

  async function getRemoteDesktop(): Promise<AnyIface> {
    const bus = await getBus();
    const proxy = await bus.getProxyObject(PORTAL_SERVICE, PORTAL_OBJECT);
    return proxy.getInterface(REMOTE_DESKTOP_IFACE) as unknown as AnyIface;
  }

  function senderToken(busName: string | null | undefined): string {
    // Per the xdg-desktop-portal spec, the Request path encodes the sender's
    // unique bus name: leading ':' stripped, dots → underscores. Tests use
    // the older '_' placeholder; real production uses the bus's unique name.
    if (!busName) return '_';
    return busName.replace(/^:/, '').replace(/\./g, '_');
  }

  function predictedRequestPath(handleToken: string, busName?: string | null): string {
    return `/org/freedesktop/portal/desktop/request/${senderToken(busName)}/${handleToken}`;
  }

  /**
   * Subscribe to a portal Request's Response signal BEFORE the method call is
   * issued. The xdg-desktop-portal spec guarantees the Request object path is
   * derived from the sender's unique name + handle_token, so we can prepare
   * the listener up-front and avoid the race where Response fires before we
   * subscribe.
   *
   * Real production path: register a bus match rule + listen for raw
   * `message` events. The dynamic Request objects don't introspect reliably,
   * so a proxy-based listener (getProxyObject(requestPath).getInterface(...))
   * throws "interface not found in proxy object" on real KDE.
   *
   * Test path: stubs expose a per-request `StubInterface` via getProxyObject;
   * we fall back to that when the bus doesn't support addMatch.
   */
  async function subscribeResponse(
    handleToken: string
  ): Promise<{ pending: Promise<Record<string, unknown>> }> {
    const bus = await getBus();
    const busAny = bus as unknown as AnyIface & { name?: string | null };
    const requestPath = predictedRequestPath(handleToken, busAny.name ?? null);

    // Test/stub bus: doesn't speak addMatch + raw messages. Use the proxy.
    if (typeof busAny._addMatch !== 'function') {
      const proxy = await bus.getProxyObject(PORTAL_SERVICE, requestPath);
      const iface = proxy.getInterface(REQUEST_IFACE) as unknown as AnyIface;
      const pending = new Promise<Record<string, unknown>>((resolve, reject) => {
        const handler = (...args: unknown[]): void => {
          const code = args[0] as number;
          const results = (args[1] ?? {}) as Record<string, unknown>;
          offListener(iface, 'Response', handler);
          if (code !== 0) {
            reject(new Error(`portal request failed (code ${code})`));
            return;
          }
          resolve(results);
        };
        iface.on('Response', handler);
      });
      return { pending };
    }

    // Real bus: install a match rule, then filter raw message events.
    const rule = `type='signal',interface='${REQUEST_IFACE}',path='${requestPath}',member='Response'`;
    await (busAny._addMatch as (r: string) => Promise<void>)(rule);

    const pending = new Promise<Record<string, unknown>>((resolve, reject) => {
      const handler = (msg: unknown): void => {
        const m = msg as {
          path?: string;
          interface?: string;
          member?: string;
          body?: unknown[];
        };
        if (
          m.path !== requestPath ||
          m.interface !== REQUEST_IFACE ||
          m.member !== 'Response'
        ) return;
        const body = m.body ?? [];
        const code = (body[0] ?? 0) as number;
        const results = (body[1] ?? {}) as Record<string, unknown>;
        busAny.off?.('message', handler);
        const removeMatch = busAny._removeMatch as ((r: string) => Promise<void>) | undefined;
        if (removeMatch) void removeMatch.call(busAny, rule).catch(() => {});
        if (code !== 0) {
          reject(new Error(`portal request failed (code ${code})`));
          return;
        }
        resolve(results);
      };
      busAny.on('message', handler);
    });
    return { pending };
  }

  async function readTokenFile(): Promise<string | null> {
    try {
      const data = await fsp.readFile(tokenPath, 'utf8');
      return data.trim() || null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async function writeTokenFile(token: string): Promise<void> {
    const tmp = `${tokenPath}.tmp`;
    await fsp.writeFile(tmp, token, 'utf8');
    await fsp.rename(tmp, tokenPath);
  }

  function variantString(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const inner = (value as VariantLike).value;
    return typeof inner === 'string' ? inner : undefined;
  }

  async function handshake(): Promise<void> {
    const rd = await getRemoteDesktop();
    const sessionToken = randomToken();
    {
      const handleToken = randomToken();
      const { pending } = await subscribeResponse(handleToken);
      await callMember(rd, 'CreateSession', {
        handle_token: v('s', handleToken),
        session_handle_token: v('s', sessionToken),
      });
      const results = await pending;
      const sp = variantString(results.session_handle);
      if (!sp) throw new Error('portal CreateSession: missing session_handle');
      sessionPath = sp;
    }
    {
      const handleToken = randomToken();
      const restore = await readTokenFile();
      const opts: Record<string, unknown> = {
        handle_token: v('s', handleToken),
        types: v('u', 2),
        persist_mode: v('u', 2),
      };
      if (restore) opts.restore_token = v('s', restore);
      const { pending } = await subscribeResponse(handleToken);
      await callMember(rd, 'SelectDevices', sessionPath!, opts);
      await pending;
    }
    {
      const handleToken = randomToken();
      const { pending } = await subscribeResponse(handleToken);
      await callMember(rd, 'Start', sessionPath!, '', {
        handle_token: v('s', handleToken),
      });
      const results = await pending;
      const newToken = variantString(results.restore_token);
      if (newToken) {
        try {
          await writeTokenFile(newToken);
        } catch (err) {
          logger.warn(
            `portal: failed to persist restore_token: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }
  }

  async function ensureSession(): Promise<void> {
    if (sessionPath) return;
    if (!handshakePromise) {
      handshakePromise = handshake().catch((err) => {
        handshakePromise = null;
        sessionPath = null;
        throw err;
      });
    }
    await handshakePromise;
  }

  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn);
    tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async function rawMove(x: number, y: number): Promise<void> {
    const rd = await getRemoteDesktop();
    const cur = getCursor();
    const dx = Math.round(x - cur.x);
    const dy = Math.round(y - cur.y);
    await callMember(rd, 'NotifyPointerMotion', sessionPath!, {}, dx, dy);
  }

  async function rawButton(button: MouseButton, state: 0 | 1): Promise<void> {
    const rd = await getRemoteDesktop();
    await callMember(rd, 'NotifyPointerButton', sessionPath!, {}, BTN_CODE[button], state);
  }

  async function rawAxis(dx: number, dy: number): Promise<void> {
    const rd = await getRemoteDesktop();
    await callMember(
      rd,
      'NotifyPointerAxis',
      sessionPath!,
      { finish: v('b', true) },
      dx * SCROLL_NOTCH,
      dy * SCROLL_NOTCH
    );
  }

  return {
    move(x, y) {
      return serialize(async () => {
        await ensureSession();
        await rawMove(x, y);
      });
    },
    click(x, y, button) {
      return serialize(async () => {
        await ensureSession();
        await rawMove(x, y);
        await rawButton(button, 1);
        await rawButton(button, 0);
      });
    },
    doubleClick(x, y, button) {
      return serialize(async () => {
        await ensureSession();
        await rawMove(x, y);
        await rawButton(button, 1);
        await rawButton(button, 0);
        await new Promise<void>((r) => setTimeout(r, DOUBLE_CLICK_DELAY_MS));
        await rawButton(button, 1);
        await rawButton(button, 0);
      });
    },
    drag(x1, y1, x2, y2, button) {
      return serialize(async () => {
        await ensureSession();
        await rawMove(x1, y1);
        await rawButton(button, 1);
        await rawMove(x2, y2);
        await rawButton(button, 0);
      });
    },
    scroll(dx, dy, x, y) {
      return serialize(async () => {
        await ensureSession();
        if (x !== undefined && y !== undefined) await rawMove(x, y);
        await rawAxis(dx, dy);
      });
    },
  };
}
