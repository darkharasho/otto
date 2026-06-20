import { spawn as nodeSpawn } from 'node:child_process';

// Detect whether a shell command will invoke `sudo` interactively somewhere.
// Matches `sudo` as a command word — at the start, or after a shell operator
// (`;`, `|`, `&`, `&&`, `||`, newline, subshell `(`) — but NOT when it already
// runs non-interactively (`sudo -n` / `sudo --non-interactive`), since those
// never prompt and must be allowed to fail fast on their own.
const SUDO_DETECT =
  /(?:^|[\n;&|(]|&&|\|\|)\s*sudo\b(?!\s+(?:-n\b|--non-interactive\b))/;

export function commandRequiresSudo(command: string): boolean {
  return SUDO_DETECT.test(command);
}

/**
 * Runs `sudo` to validate a password and prime its credential cache
 * ("timestamp"). Injected so the SudoSession is unit-testable without a real
 * sudo binary.
 */
export interface SudoRunner {
  /**
   * Feed `password` to `sudo -S -v`, priming the timestamp on success.
   * Resolves `{ ok: false, stderr }` on a wrong password rather than throwing.
   */
  validate(password: string): Promise<{ ok: boolean; stderr: string }>;
}

/** Turn sudo's stderr into a short, user-facing reason. */
export function parseSudoError(stderr: string): string {
  const s = stderr.toLowerCase();
  if (s.includes('incorrect password') || s.includes('sorry, try again')) {
    return 'Incorrect password';
  }
  if (s.includes('not in the sudoers') || s.includes('not allowed')) {
    return 'This user is not permitted to run sudo';
  }
  const firstLine = stderr.split('\n').map((l) => l.trim()).filter(Boolean)[0];
  return firstLine || 'sudo authentication failed';
}

export const realSudoRunner: SudoRunner = {
  validate(password) {
    return new Promise((resolve) => {
      // `-S` reads the password from stdin; `-p ''` suppresses the prompt text;
      // `-v` only validates/extends the timestamp without running a command.
      // stdin is a pipe so we can write the password; stdout is ignored.
      const child = nodeSpawn('sudo', ['-S', '-p', '', '-v'], {
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.once('error', (err) => {
        resolve({ ok: false, stderr: (err as Error).message });
      });
      child.once('exit', (code) => {
        resolve({ ok: code === 0, stderr });
      });
      child.stdin.write(password + '\n');
      child.stdin.end();
    });
  },
};

export interface SudoSessionDeps {
  runner?: SudoRunner;
  /** How often to refresh the sudo timestamp so it never lapses. */
  keepAliveMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  logger?: { warn: (msg: string) => void };
}

/**
 * Holds an elevated credential in memory for the duration of one Otto session.
 *
 * The password is captured once (via the SudoBroker's prompt), validated, and
 * then a keep-alive timer re-primes sudo's timestamp on an interval so that
 * subsequent `sudo` commands — spawned with no TTY — hit the cached timestamp
 * and never prompt again. The password is wiped when the session changes or is
 * cleared explicitly (session close / idle reset / app quit).
 *
 * Note: this relies on sudo's no-TTY timestamp record being shared across
 * Otto's spawned `sh -c` processes. That holds on standard sudoers configs;
 * unusual setups (per-process tickets, `targetpw`) may still re-prompt.
 */
export class SudoSession {
  private password: string | null = null;
  private sessionId: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  private readonly runner: SudoRunner;
  private readonly keepAliveMs: number;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private readonly logger: { warn: (msg: string) => void };

  constructor(deps: SudoSessionDeps = {}) {
    this.runner = deps.runner ?? realSudoRunner;
    this.keepAliveMs = deps.keepAliveMs ?? 60_000;
    this.setIntervalFn = deps.setIntervalFn ?? setInterval;
    this.clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
    this.logger = deps.logger ?? { warn: () => {} };
  }

  isUnlocked(sessionId: string): boolean {
    return this.password !== null && this.sessionId === sessionId;
  }

  /**
   * Validate `password` and, on success, hold it for `sessionId` and start the
   * keep-alive. Validating always resets any prior session's credential.
   */
  async unlock(sessionId: string, password: string): Promise<{ ok: boolean; error?: string }> {
    const res = await this.runner.validate(password);
    if (!res.ok) {
      return { ok: false, error: parseSudoError(res.stderr) };
    }
    this.clear();
    this.password = password;
    this.sessionId = sessionId;
    this.startKeepAlive();
    return { ok: true };
  }

  /** Wipe the in-memory credential and stop the keep-alive. */
  clear(): void {
    this.password = null;
    this.sessionId = null;
    if (this.timer) {
      this.clearIntervalFn(this.timer);
      this.timer = null;
    }
  }

  /** Clear the credential if the active session has rolled over to a new one. */
  notifySession(sessionId: string): void {
    if (this.sessionId !== null && this.sessionId !== sessionId) {
      this.clear();
    }
  }

  private startKeepAlive(): void {
    this.timer = this.setIntervalFn(() => {
      const pw = this.password;
      if (pw === null) return;
      void this.runner.validate(pw).then((res) => {
        if (!res.ok) {
          // Password no longer works (changed, revoked) — drop it so the next
          // elevated command re-prompts rather than silently failing.
          this.logger.warn(`sudo keep-alive failed, clearing credential: ${parseSudoError(res.stderr)}`);
          this.clear();
        }
      });
    }, this.keepAliveMs);
    // Don't let the keep-alive keep the process alive on its own.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }
}
