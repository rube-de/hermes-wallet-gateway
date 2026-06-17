// Routes-only mode: HERMES_TARGET is empty (no catch-all), so a path matching no
// GATEWAY_ROUTES prefix must get a 502 (not hang), while a matched path still
// proxies. Run in its own process because config.ts reads env once at load.
//
//   cd gateway && npm install && node test/routes-only.ts

const SEC_PORT = 9952;

process.env.PORT = process.env.PORT || '8080';
process.env.HERMES_TARGET = ''; // explicitly empty => no catch-all
process.env.GATEWAY_ROUTES = JSON.stringify({ '/security': `http://127.0.0.1:${SEC_PORT}` });
process.env.WALLET_DOMAIN = 'localhost:8080';
process.env.COOKIE_SECURE = 'false';
process.env.WALLET_CHAIN_ID = '1';
process.env.WALLET_SESSION_SECRET = 'local-dev-secret-not-for-production-0123456789abcdef';
process.env.WALLET_WHITELIST = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

import http from 'node:http';
import { privateKeyToAccount } from 'viem/accounts';
import { login, WHITELISTED_PK } from './checks.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let wsHits = 0;
const security = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`UPSTREAM=security ${req.method} ${req.url}`);
});
security.on('upgrade', (_req, socket) => {
  wsHits++;
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  socket.end();
});
await new Promise<void>((r) => security.listen(SEC_PORT, r));

await import('../src/server.ts');

const base = `http://localhost:${process.env.PORT}`;
let ready = false;
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(`${base}/healthz`)).ok) {
      ready = true;
      break;
    }
  } catch {
    /* not up yet */
  }
  await sleep(100);
}
if (!ready) {
  console.error('gateway did not become ready');
  process.exit(1);
}

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

function wsProbe(path: string, cookie: string): Promise<string> {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: Number(process.env.PORT),
      path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        Cookie: cookie,
      },
    });
    const done = (v: string): void => {
      req.destroy();
      resolve(v);
    };
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      done('upgrade');
    });
    req.on('response', (res) => done(`response:${res.statusCode}`));
    req.on('error', () => done('error'));
    req.end();
    setTimeout(() => done('timeout'), 1500);
  });
}

console.log(`\nroutes-only checks → ${base}`);

const { cookie } = await login(base, privateKeyToAccount(WHITELISTED_PK));
check('whitelisted wallet → session cookie', cookie.startsWith('hermes_wallet_session='), cookie);

// Matched prefix still proxies.
const matched = await fetch(`${base}/security/api`, { headers: { cookie } });
const matchedBody = await matched.text();
check('GET /security/... → security upstream (matched)',
  matched.status === 200 && matchedBody === 'UPSTREAM=security GET /security/api', `${matched.status} ${matchedBody}`);

// Unmatched path with no catch-all → 502 (does not hang, does not 200).
const unmatched = await fetch(`${base}/dashboard`, { headers: { cookie } });
const unmatchedBody = await unmatched.text();
check('GET /dashboard (unmatched, no catch-all) → 502',
  unmatched.status === 502 && unmatchedBody.includes('No upstream configured'), `${unmatched.status} ${unmatchedBody}`);

// WS upgrade to an unmatched path with no catch-all → dropped (no upstream hit).
wsHits = 0;
const w = await wsProbe('/dashboard', cookie);
await sleep(50);
check('WS /dashboard (unmatched, no catch-all) → dropped', w !== 'upgrade' && wsHits === 0, `${w} hits=${wsHits}`);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
security.close();
process.exit(fail === 0 ? 0 : 1);
