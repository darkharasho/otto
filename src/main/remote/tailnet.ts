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
