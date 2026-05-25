import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const TTL_MS = 60_000;

export class ScreenshotUrlSigner {
  private readonly consumed = new Set<string>();
  constructor(private readonly secret: string, private readonly now: () => number = Date.now) {}

  sign(id: string): string {
    const exp = this.now() + TTL_MS;
    const nonce = randomBytes(8).toString('base64url');
    const sig = this.hmac(`${id}|${exp}|${nonce}`);
    return `/screenshot/${encodeURIComponent(id)}?id=${encodeURIComponent(id)}&exp=${exp}&nonce=${nonce}&sig=${sig}`;
  }

  verify(url: string): { ok: boolean; id: string | null } {
    const u = new URL(url, 'http://x');
    const id = u.searchParams.get('id') ?? '';
    const exp = Number(u.searchParams.get('exp') ?? '0');
    const nonce = u.searchParams.get('nonce') ?? '';
    const sig = u.searchParams.get('sig') ?? '';
    if (!id || !exp || !nonce || !sig) return { ok: false, id: null };
    if (this.now() > exp) return { ok: false, id: null };
    const expected = this.hmac(`${id}|${exp}|${nonce}`);
    if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return { ok: false, id: null };
    const consumeKey = `${id}|${exp}|${nonce}|${sig}`;
    if (this.consumed.has(consumeKey)) return { ok: false, id: null };
    this.consumed.add(consumeKey);
    return { ok: true, id };
  }

  private hmac(s: string): string {
    return createHmac('sha256', this.secret).update(s).digest('base64url');
  }
}
