// Shared smoke-test assertions for the wallet gateway. Drives the full SIWE
// flow with a private key (no browser/MetaMask needed) and checks the gate.

import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import type { Hex } from 'viem';

// Hardhat dev account #0 — its address is whitelisted in the local configs.
export const WHITELISTED_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
// Hardhat dev account #1 — deliberately NOT whitelisted.
const STRANGER_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;

// Must match the gateway's WALLET_DOMAIN / WALLET_CHAIN_ID in the local configs.
const DOMAIN = process.env.SMOKE_DOMAIN || 'localhost:8080';
const CHAIN_ID = Number(process.env.SMOKE_CHAIN_ID || 1);

type Account = ReturnType<typeof privateKeyToAccount>;

// Mirrors what the RainbowKit/wagmi login app does: fetch a bare nonce, build
// the EIP-4361 message client-side, sign it, then POST to verify.
async function buildSigned(base: string, account: Account): Promise<{ message: string; signature: Hex }> {
  const { nonce } = (await fetch(`${base}/siwe/nonce`).then((r) => r.json())) as { nonce: string };
  const message = createSiweMessage({
    address: account.address,
    chainId: CHAIN_ID,
    domain: DOMAIN,
    uri: `http://${DOMAIN}`,
    nonce,
    version: '1',
    statement: 'Sign in to the Hermes dashboard.',
    issuedAt: new Date(),
    expirationTime: new Date(Date.now() + 5 * 60 * 1000),
  });
  const signature = await account.signMessage({ message });
  return { message, signature };
}

interface LoginResult {
  ok: boolean;
  status: number;
  cookie: string;
}

export async function login(base: string, account: Account): Promise<LoginResult> {
  const { message, signature } = await buildSigned(base, account);
  const v = await fetch(`${base}/siwe/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, signature }),
  });
  const setCookie = v.headers.getSetCookie?.()[0] || v.headers.get('set-cookie') || '';
  return { ok: v.ok, status: v.status, cookie: setCookie.split(';')[0] };
}

export async function runChecks(base: string): Promise<{ pass: number; fail: number }> {
  const allowed = privateKeyToAccount(WHITELISTED_PK);
  const stranger = privateKeyToAccount(STRANGER_PK);
  let pass = 0;
  let fail = 0;
  const check = (name: string, cond: boolean, extra = ''): void => {
    if (cond) {
      console.log(`  ✓ ${name}`);
      pass++;
    } else {
      console.log(`  ✗ ${name}  ${extra}`);
      fail++;
    }
  };

  console.log(`\nSIWE gateway smoke test → ${base}`);
  console.log(`whitelisted address: ${allowed.address}\n`);

  // 1. Unauthenticated request returns the login app (SPA shell, or the
  //    dependency-free fallback page if the React app wasn't built).
  const r1 = await fetch(base);
  const b1 = await r1.text();
  check('GET / unauthenticated → login app',
    r1.status === 200 && (b1.includes('id="root"') || b1.includes('Connect wallet')),
    `status=${r1.status}`);

  // 2-4. Whitelisted wallet completes the SIWE handshake and gets a cookie.
  const good = await login(base, allowed);
  check('whitelisted wallet → verify 200 + session cookie',
    good.ok && good.cookie.startsWith('hermes_wallet_session='), `status=${good.status}`);

  // 5. With the session cookie, the request is proxied to the upstream (i.e.
  //    NOT the login app shell).
  const r5 = await fetch(base, { headers: { cookie: good.cookie } });
  const b5 = await r5.text();
  check('GET / with session → proxied upstream (not login app)',
    r5.status === 200 && !b5.includes('id="root"') && !b5.includes('Connect wallet'),
    `status=${r5.status} body=${b5.slice(0, 50)}`);

  // 6. Non-whitelisted wallet is rejected with a generic 401.
  const bad = await login(base, stranger);
  check('non-whitelisted wallet → 401', bad.status === 401, `status=${bad.status}`);

  // 7. Replaying a consumed nonce is rejected (single-use).
  const { message, signature } = await buildSigned(base, allowed);
  const first = await fetch(`${base}/siwe/verify`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, signature }),
  });
  const replay = await fetch(`${base}/siwe/verify`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, signature }),
  });
  check('replay of a consumed nonce → 401', first.ok && replay.status === 401,
    `first=${first.status} replay=${replay.status}`);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
  return { pass, fail };
}
