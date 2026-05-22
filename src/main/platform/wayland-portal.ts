import * as dbus from 'dbus-next';
import { randomBytes } from 'node:crypto';
import { logger } from '../logger';

const PORTAL_BUS = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const GLOBAL_SHORTCUTS_IFACE = 'org.freedesktop.portal.GlobalShortcuts';
const REQUEST_IFACE = 'org.freedesktop.portal.Request';
const SESSION_IFACE = 'org.freedesktop.portal.Session';

type RegisterResult = { ok: true } | { ok: false; reason: string };

/**
 * Translate an Electron-style accelerator (e.g. "Control+Alt+Space")
 * to the xdg-desktop-portal accelerator string (XKB/GTK convention,
 * e.g. "CTRL+ALT+space").
 */
export function electronAcceleratorToPortal(accel: string): string {
  return accel
    .split('+')
    .map((p) => p.trim())
    .map((p) => {
      const lower = p.toLowerCase();
      if (lower === 'control' || lower === 'ctrl' || lower === 'commandorcontrol' || lower === 'cmdorctrl') return 'CTRL';
      if (lower === 'alt' || lower === 'option') return 'ALT';
      if (lower === 'shift') return 'SHIFT';
      if (lower === 'super' || lower === 'meta' || lower === 'cmd' || lower === 'command') return 'SUPER';
      // Key portion: keep as-is for single chars but lowercase named keys (e.g. Space -> space)
      return lower;
    })
    .join('+');
}

function randomToken(): string {
  return 'otto_' + randomBytes(8).toString('hex');
}

function senderTokenFromBusName(uniqueName: string): string {
  // uniqueName looks like ":1.42". Strip leading colon and replace dots with underscores.
  return uniqueName.replace(/^:/, '').replace(/\./g, '_');
}

export class WaylandPortalHotkey {
  private bus: dbus.MessageBus | null = null;
  private sessionHandle: string | null = null;
  private onTrigger: (() => void) | null = null;
  private activatedHandler: ((msg: dbus.Message) => void) | null = null;

  constructor(
    private readonly accelerator: string,
    private readonly shortcutId: string,
    private readonly label: string
  ) {}

  async register(onTrigger: () => void): Promise<RegisterResult> {
    this.onTrigger = onTrigger;
    try {
      this.bus = dbus.sessionBus();
    } catch (err) {
      return { ok: false, reason: `D-Bus session connect failed: ${errMsg(err)}` };
    }

    let uniqueName: string;
    try {
      // Trigger a "Hello" by requesting a no-op proxy; dbus-next auto-connects.
      // Access internal "name" once connected. Cast to any — internal API.
      const bus = this.bus as any;
      // Wait for the bus to have a name.
      if (!bus.name) {
        await new Promise<void>((resolve, reject) => {
          const onConnect = () => {
            bus.removeListener('error', onError);
            resolve();
          };
          const onError = (e: unknown) => {
            bus.removeListener('connect', onConnect);
            reject(e);
          };
          bus.once('connect', onConnect);
          bus.once('error', onError);
          // dbus-next may have already connected; fall back to a small delay.
          setTimeout(() => {
            if (bus.name) {
              bus.removeListener('connect', onConnect);
              bus.removeListener('error', onError);
              resolve();
            }
          }, 50);
        });
      }
      uniqueName = bus.name;
      if (!uniqueName) {
        // As a last resort, try to call org.freedesktop.DBus.Hello implicitly via a proxy.
        const dbusProxy = await this.bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus');
        const iface = dbusProxy.getInterface('org.freedesktop.DBus');
        uniqueName = (await (iface as any).GetId()) as string;
        uniqueName = (this.bus as any).name ?? uniqueName;
      }
    } catch (err) {
      return { ok: false, reason: `Failed to obtain bus name: ${errMsg(err)}` };
    }

    const senderToken = senderTokenFromBusName(uniqueName);

    // --- CreateSession ---
    // Portal returns a Request object path; the Response signal on that path
    // carries the eventual result. We pre-compute the expected request path
    // using our handle_token and subscribe before issuing the call.
    const createHandleToken = randomToken();
    const sessionHandleToken = randomToken();
    const createRequestPath = `/org/freedesktop/portal/desktop/request/${senderToken}/${createHandleToken}`;
    const expectedSessionPath = `/org/freedesktop/portal/desktop/session/${senderToken}/${sessionHandleToken}`;

    let portalProxy: dbus.ProxyObject;
    try {
      portalProxy = await this.bus.getProxyObject(PORTAL_BUS, PORTAL_PATH);
    } catch (err) {
      return { ok: false, reason: `Portal not available: ${errMsg(err)}` };
    }
    const shortcuts = portalProxy.getInterface(GLOBAL_SHORTCUTS_IFACE) as unknown as
      | (dbus.ClientInterface & {
          CreateSession: (options: Record<string, dbus.Variant>) => Promise<string>;
          BindShortcuts: (
            session: string,
            shortcuts: Array<[string, Record<string, dbus.Variant>]>,
            parentWindow: string,
            options: Record<string, dbus.Variant>
          ) => Promise<string>;
        })
      | null;
    if (!shortcuts) {
      return { ok: false, reason: 'GlobalShortcuts portal interface not found' };
    }

    try {
      await this.waitForResponse(createRequestPath, async () => {
        await shortcuts.CreateSession({
          handle_token: new dbus.Variant('s', createHandleToken),
          session_handle_token: new dbus.Variant('s', sessionHandleToken),
          // KDE's portal requires this; freedesktop spec marks it optional.
          app_id: new dbus.Variant('s', 'dev.otto.app'),
        });
      });
    } catch (err) {
      return { ok: false, reason: `CreateSession failed: ${errMsg(err)}` };
    }
    this.sessionHandle = expectedSessionPath;

    // --- BindShortcuts ---
    const bindHandleToken = randomToken();
    const bindRequestPath = `/org/freedesktop/portal/desktop/request/${senderToken}/${bindHandleToken}`;
    const portalAccelerator = electronAcceleratorToPortal(this.accelerator);

    try {
      await this.waitForResponse(bindRequestPath, async () => {
        await shortcuts.BindShortcuts(
          expectedSessionPath,
          [
            [
              this.shortcutId,
              {
                description: new dbus.Variant('s', this.label),
                preferred_trigger: new dbus.Variant('s', portalAccelerator),
              },
            ],
          ],
          '',
          { handle_token: new dbus.Variant('s', bindHandleToken) }
        );
      });
    } catch (err) {
      return { ok: false, reason: `BindShortcuts failed: ${errMsg(err)}` };
    }

    // --- Subscribe to Activated signal on the session ---
    try {
      await this.subscribeActivated(expectedSessionPath);
    } catch (err) {
      return { ok: false, reason: `Failed to subscribe Activated signal: ${errMsg(err)}` };
    }

    logger.info(`wayland portal hotkey bound: ${portalAccelerator} (session=${expectedSessionPath})`);
    return { ok: true };
  }

  /**
   * Subscribe to a Request.Response signal on `requestPath`, invoke `call`,
   * then resolve when the Response arrives (response code 0 = success).
   */
  private async waitForResponse(requestPath: string, call: () => Promise<void>): Promise<void> {
    if (!this.bus) throw new Error('no bus');
    const bus = this.bus as any;

    // Add match rule for the Response signal on this request path.
    const matchRule = `type='signal',interface='${REQUEST_IFACE}',member='Response',path='${requestPath}'`;
    await this.addMatch(matchRule);

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        bus.removeListener('message', handler);
        this.removeMatch(matchRule).catch(() => {});
        reject(new Error('timeout waiting for portal Response signal'));
      }, 30000);

      const handler = (msg: dbus.Message) => {
        if (
          msg.type !== dbus.MessageType.SIGNAL ||
          msg.interface !== REQUEST_IFACE ||
          msg.member !== 'Response' ||
          msg.path !== requestPath
        ) {
          return;
        }
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        bus.removeListener('message', handler);
        this.removeMatch(matchRule).catch(() => {});
        const body = msg.body ?? [];
        const code = body[0] as number;
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`portal returned response code ${code}`));
        }
      };
      bus.on('message', handler);

      call().catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        bus.removeListener('message', handler);
        this.removeMatch(matchRule).catch(() => {});
        reject(err);
      });
    });
  }

  private async subscribeActivated(sessionPath: string): Promise<void> {
    if (!this.bus) throw new Error('no bus');
    const bus = this.bus as any;
    const matchRule = `type='signal',interface='${GLOBAL_SHORTCUTS_IFACE}',member='Activated',path='${sessionPath}'`;
    await this.addMatch(matchRule);

    const handler = (msg: dbus.Message) => {
      if (
        msg.type !== dbus.MessageType.SIGNAL ||
        msg.interface !== GLOBAL_SHORTCUTS_IFACE ||
        msg.member !== 'Activated' ||
        msg.path !== sessionPath
      ) {
        return;
      }
      const body = msg.body ?? [];
      // body: (o session_handle, s shortcut_id, t timestamp, a{sv} options)
      const id = body[1] as string;
      if (id === this.shortcutId) {
        try {
          this.onTrigger?.();
        } catch (err) {
          logger.warn(`hotkey trigger callback threw: ${errMsg(err)}`);
        }
      }
    };
    this.activatedHandler = handler;
    bus.on('message', handler);
  }

  private async addMatch(rule: string): Promise<void> {
    if (!this.bus) return;
    const dbusProxy = await this.bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus');
    const iface = dbusProxy.getInterface('org.freedesktop.DBus') as unknown as { AddMatch: (rule: string) => Promise<void> };
    await iface.AddMatch(rule);
  }

  private async removeMatch(rule: string): Promise<void> {
    if (!this.bus) return;
    const dbusProxy = await this.bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus');
    const iface = dbusProxy.getInterface('org.freedesktop.DBus') as unknown as { RemoveMatch: (rule: string) => Promise<void> };
    await iface.RemoveMatch(rule);
  }

  async dispose(): Promise<void> {
    if (!this.bus) return;
    const bus = this.bus as any;
    if (this.activatedHandler) {
      bus.removeListener('message', this.activatedHandler);
      this.activatedHandler = null;
    }
    if (this.sessionHandle) {
      try {
        const sessionProxy = await this.bus.getProxyObject(PORTAL_BUS, this.sessionHandle);
        const sessionIface = sessionProxy.getInterface(SESSION_IFACE) as unknown as { Close: () => Promise<void> };
        await sessionIface.Close();
      } catch (err) {
        logger.warn(`failed to close portal session: ${errMsg(err)}`);
      }
      this.sessionHandle = null;
    }
    try {
      this.bus.disconnect();
    } catch {
      // ignore
    }
    this.bus = null;
  }
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
