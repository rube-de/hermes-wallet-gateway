// Stateless, HMAC-signed session cookies.
//
// Mirrors the Hermes `basic` dashboard-auth provider: a JSON payload signed
// with HMAC-SHA256, base64url-encoded. No server-side session store, so the
// gateway stays stateless and horizontally scalable (the only shared state is
// the nonce store in siwe.ts, which matters only if you run >1 replica).

import crypto from 'node:crypto';
import config from './config.ts';

export const SESSION_COOKIE = 'hermes_wallet_session';
const SIG_LEN = 32; // HMAC-SHA256 digest length

interface SessionPayload {
  sub: string;
  iat: number;
  exp: number;
}

function sign(payload: SessionPayload): string {
  const raw = Buffer.from(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', config.secret).update(raw).digest();
  return Buffer.concat([raw, sig]).toString('base64url');
}

function unsign(token: string): SessionPayload | null {
  let blob: Buffer;
  try {
    blob = Buffer.from(token, 'base64url');
  } catch {
    return null;
  }
  if (blob.length <= SIG_LEN) return null;
  const raw = blob.subarray(0, blob.length - SIG_LEN);
  const sig = blob.subarray(blob.length - SIG_LEN);
  const expected = crypto.createHmac('sha256', config.secret).update(raw).digest();
  // Constant-time compare; both buffers are SIG_LEN bytes.
  if (!crypto.timingSafeEqual(sig, expected)) return null;
  try {
    return JSON.parse(raw.toString()) as SessionPayload;
  } catch {
    return null;
  }
}

function cookieAttrs(value: string, maxAge: number): string {
  const attrs = [
    `${SESSION_COOKIE}=${value}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (config.cookieSecure) attrs.push('Secure');
  return attrs.join('; ');
}

export function mintCookie(address: string): string {
  const now = Math.floor(Date.now() / 1000);
  const token = sign({ sub: address, iat: now, exp: now + config.sessionTtlSeconds });
  return cookieAttrs(token, config.sessionTtlSeconds);
}

export function clearCookie(): string {
  return cookieAttrs('', 0);
}

export function verifySession(token: string): { address: string } | null {
  const p = unsign(token);
  if (!p || !p.sub || (p.exp || 0) <= Math.floor(Date.now() / 1000)) return null;
  return { address: p.sub };
}
