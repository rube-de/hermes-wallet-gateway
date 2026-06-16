// SIWE (EIP-4361) verification, plus the whitelist gate.
//
// The client (RainbowKit/wagmi) builds the EIP-4361 message itself; the server
// issues a single-use nonce and re-validates everything: domain, chain, expiry,
// signer recovery, and the allowlist. Replay protection rests on the
// server-side single-use nonce (consumed on first verify), NOT on the signature
// bytes (ECDSA is malleable).

import { generateSiweNonce, parseSiweMessage } from 'viem/siwe';
import { recoverMessageAddress, isAddress, getAddress, type Hex } from 'viem';
import config from './config.ts';

// nonce -> expiry (ms since epoch). In-memory: fine for a single gateway
// replica. If you scale to >1 replica, move this to Redis (SETEX + atomic
// GETDEL) — an in-memory map would let a nonce issued by replica A be unknown
// to replica B, causing intermittent failures and a replay window.
const nonces = new Map<string, number>();

setInterval(() => {
  const now = Date.now();
  for (const [nonce, exp] of nonces) if (exp <= now) nonces.delete(nonce);
}, 60_000).unref();

// Issue a bare single-use nonce. The client builds the EIP-4361 message with
// viem's createSiweMessage; the server stays the authority on nonce validity
// (single-use + TTL) and re-validates the rest in verifyLogin.
export function issueNonce(): string {
  const nonce = generateSiweNonce();
  nonces.set(nonce, Date.now() + config.nonceTtlSeconds * 1000);
  return nonce;
}

function consumeNonce(nonce: string): boolean {
  const exp = nonces.get(nonce);
  if (exp === undefined) return false;
  nonces.delete(nonce); // single-use: gone after the first attempt
  return exp > Date.now();
}

// The whitelist predicate. v1 = off-chain set lookup. To upgrade (DB,
// token-gating, Sapphire confidential read) replace ONLY this function.
function isAllowed(address: string): boolean {
  return config.whitelist.has(address.toLowerCase());
}

export async function verifyLogin(body: {
  message?: unknown;
  signature?: unknown;
}): Promise<{ address: string }> {
  const { message, signature } = body;
  if (typeof message !== 'string' || typeof signature !== 'string') {
    throw new Error('bad input');
  }

  const fields = parseSiweMessage(message);

  // Server-authoritative single-use nonce — the real replay defense. Do this
  // first so a missing/stale/replayed nonce is rejected before any crypto.
  if (!fields.nonce || !consumeNonce(fields.nonce)) throw new Error('bad nonce');

  // Domain binding (anti-phishing): the message must claim one of OUR hosts.
  if (!fields.domain || !config.domains.has(fields.domain.toLowerCase())) {
    throw new Error('domain mismatch');
  }

  if (Number(fields.chainId) !== config.chainId) throw new Error('chain mismatch');
  if (fields.expirationTime && fields.expirationTime.getTime() <= Date.now()) {
    throw new Error('expired');
  }
  if (fields.notBefore && fields.notBefore.getTime() > Date.now()) {
    throw new Error('not yet valid');
  }
  if (!fields.address || !isAddress(fields.address)) throw new Error('bad address');

  // EOA recovery (EIP-191 personal_sign). NOTE: this rejects smart-contract /
  // AA wallets (Safe, ERC-4337) — they need EIP-1271. For v1 we are EOA-only;
  // Phase 3 swaps this for viem's verifySiweMessage(publicClient, ...) to add
  // EIP-1271 support.
  const recovered = await recoverMessageAddress({ message, signature: signature as Hex });
  if (recovered.toLowerCase() !== fields.address.toLowerCase()) {
    throw new Error('signature mismatch');
  }

  if (!isAllowed(recovered)) throw new Error('not on allowlist');

  return { address: getAddress(recovered) };
}
