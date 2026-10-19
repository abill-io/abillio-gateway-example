// Partner guide §10, verbatim: `X-Timestamp` within 300 s, `X-Signature:
// t=<ts>,v1=<hex>`, v1 = HMAC-SHA256(secret, "<ts>." + raw body), compared
// in constant time. The raw bytes matter: a body your framework re-serialised
// is a different body.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const WINDOW_SECONDS = 300;

export type Verification =
  | { ok: true; timestamp: number }
  | { ok: false; status: 400 | 401; reason: string };

export function verifySignature(
  secret: string,
  headers: { timestamp: string | null; signature: string | null },
  rawBody: Buffer,
  now: () => number = Date.now,
): Verification {
  if (!headers.timestamp || !/^\d+$/.test(headers.timestamp)) return { ok: false, status: 400, reason: 'missing X-Timestamp' };
  const timestamp = Number(headers.timestamp);
  if (Math.abs(now() / 1000 - timestamp) > WINDOW_SECONDS) return { ok: false, status: 400, reason: 'timestamp outside the 300 s window' };
  const sent = /(?:^|,)v1=([0-9a-f]+)/.exec(headers.signature ?? '')?.[1];
  if (!sent) return { ok: false, status: 401, reason: 'missing v1 signature' };
  const expected = createHmac('sha256', secret).update(`${headers.timestamp}.`).update(rawBody).digest('hex');
  const a = Buffer.from(sent, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, status: 401, reason: 'signature mismatch' };
  return { ok: true, timestamp };
}

// Retries are signed afresh with a NEW timestamp but carry the same body, so
// the body is the key — not the signature, not the timestamp. The sender adds
// no delivery id: two deliveries with byte-identical bodies are the same
// delivery by design and are stored once.
export function dedupeKey(eventType: string, rawBody: Buffer): string {
  return `${eventType}:${createHash('sha256').update(rawBody).digest('hex')}`;
}

export function parseDelivery(rawBody: Buffer): { event_type: string; data: Record<string, unknown> } | null {
  try {
    const parsed = JSON.parse(rawBody.toString('utf8')) as { event_type?: unknown; data?: unknown };
    if (typeof parsed.event_type !== 'string') return null;
    return { event_type: parsed.event_type, data: (parsed.data ?? {}) as Record<string, unknown> };
  } catch {
    return null;
  }
}
