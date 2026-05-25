import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface ExecResult { stdout: string; stderr: string; code: number }
export interface ExecFn { (cmd: string, args: string[]): Promise<ExecResult> }

const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

const defaultExec: ExecFn = async (cmd, args) => {
  try {
    const r = await execFileP(cmd, args);
    return { stdout: r.stdout, stderr: r.stderr, code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: string | number; stdout?: string; stderr?: string };
    if (e.code === 'ENOENT') throw e;
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: typeof e.code === 'number' ? e.code : 1 };
  }
};

export async function resolveTailnetIp(opts: { exec?: (args?: string[]) => Promise<ExecResult> } = {}): Promise<string | null> {
  const exec = opts.exec ?? ((args = ['ip', '-4']) => defaultExec('tailscale', args));
  try {
    const r = await exec();
    if (r.code !== 0) return null;
    const ip = r.stdout.trim().split(/\s+/)[0] ?? '';
    return IPV4_RE.test(ip) ? ip : null;
  } catch {
    return null;
  }
}

export interface TailnetEndpoint { ip: string | null; host: string | null }

interface TailscaleStatus {
  Self?: { HostName?: string; DNSName?: string; TailscaleIPs?: string[] };
  MagicDNSSuffix?: string;
}

export async function resolveTailnetEndpoint(opts: { exec?: () => Promise<ExecResult> } = {}): Promise<TailnetEndpoint> {
  const exec = opts.exec ?? (() => defaultExec('tailscale', ['status', '--json']));
  try {
    const r = await exec();
    if (r.code !== 0) return { ip: null, host: null };
    const j = JSON.parse(r.stdout) as TailscaleStatus;
    const ips = j.Self?.TailscaleIPs ?? [];
    const ip = ips.find((s) => IPV4_RE.test(s)) ?? null;
    let host: string | null = null;
    if (j.MagicDNSSuffix && j.Self?.HostName) {
      host = `${j.Self.HostName}.${j.MagicDNSSuffix.replace(/\.$/, '')}`;
    } else if (j.Self?.DNSName) {
      host = j.Self.DNSName.replace(/\.$/, '') || null;
    }
    return { ip, host };
  } catch {
    return { ip: null, host: null };
  }
}
