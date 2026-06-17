// Path-based multi-upstream routing checks. Spins up TWO mock upstreams (a
// catch-all "main" and a "/security" route) + the real gateway in-process, then
// drives the SIWE flow and asserts routing, boundary matching, the no-rewrite
// contract, header pass-through, auth uniformity (no bypass), and WS routing.
//
//   cd gateway && npm install && node test/routing.ts

const MAIN_PORT = 9941;
const SEC_PORT = 9942;

// Config must be set BEFORE importing the gateway (config.ts reads it at load).
process.env.PORT = process.env.PORT || '8080';
process.env.HERMES_TARGET = `http://127.0.0.1:${MAIN_PORT}`;
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

// Every upstream-received WS upgrade is recorded here so we can assert which
// upstream the gateway forwarded it to (and with what — untouched — path).
const wsHits: Array<{ id: string; url: string }> = [];

// A mock upstream: HTTP echoes its id + the EXACT url received (so a path rewrite
// would show up) + the received Authorization header (so header stripping would
// show up). WS upgrades are recorded and accepted, then closed.
function mockUpstream(id: string): http.Server {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`UPSTREAM=${id} ${req.method} ${req.url} auth=${req.headers.authorization ?? '-'}`);
  });
  srv.on('upgrade', (req, socket) => {
    wsHits.push({ id, url: req.url ?? '' });
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.end();
  });
  return srv;
}

const main = mockUpstream('main');
const security = mockUpstream('security');
await new Promise<void>((r) => main.listen(MAIN_PORT, r));
await new Promise<void>((r) => security.listen(SEC_PORT, r));

// Importing server.ts starts the gateway (top-level server.listen()).
await import('../src/server.ts');

const base = `http://localhost:${process.env.PORT}`;

// Wait for readiness.
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

async function get(
  path: string,
  cookie?: string,
  extra: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const headers = { ...(cookie ? { cookie } : {}), ...extra };
  const r = await fetch(`${base}${path}`, Object.keys(headers).length ? { headers } : undefined);
  return { status: r.status, body: await r.text() };
}

// Probe a WS upgrade; resolves with the outcome and leaves a wsHits entry iff
// the gateway actually forwarded the upgrade to an upstream.
function wsProbe(path: string, cookie?: string): Promise<string> {
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
        ...(cookie ? { Cookie: cookie } : {}),
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

console.log(`\nrouting checks → ${base}`);

const allowed = privateKeyToAccount(WHITELISTED_PK);
const { cookie } = await login(base, allowed);
check('whitelisted wallet → session cookie', cookie.startsWith('hermes_wallet_session='), cookie);

// 1. /security/... routes to the security upstream, path forwarded untouched.
const r1 = await get('/security/api/status', cookie);
check('GET /security/... → security upstream (no rewrite)',
  r1.status === 200 && r1.body === 'UPSTREAM=security GET /security/api/status auth=-', JSON.stringify(r1));

// 2. The route prefix itself (exact, on a boundary) hits the security upstream.
const r2 = await get('/security', cookie);
check('GET /security (exact) → security upstream',
  r2.status === 200 && r2.body === 'UPSTREAM=security GET /security auth=-', JSON.stringify(r2));

// 3. Catch-all: an unrouted path goes to HERMES_TARGET (main), untouched.
const r3 = await get('/api/pty', cookie);
check('GET /api/pty (unrouted) → main upstream (catch-all)',
  r3.status === 200 && r3.body === 'UPSTREAM=main GET /api/pty auth=-', JSON.stringify(r3));

// 4. Boundary: "/securityx" must NOT match the "/security" prefix.
const r4 = await get('/securityx/foo', cookie);
check('GET /securityx → main upstream (boundary, not /security)',
  r4.status === 200 && r4.body === 'UPSTREAM=main GET /securityx/foo auth=-', JSON.stringify(r4));

// 5. Authorization is forwarded UNTOUCHED to a routed upstream (req 8: routed
//    write APIs enforce their own bearer; the gateway must not strip it).
const rAuth = await get('/security/api', cookie, { authorization: 'Bearer test-token-123' });
check('GET /security/... with Authorization → header forwarded untouched',
  rAuth.status === 200 && rAuth.body === 'UPSTREAM=security GET /security/api auth=Bearer test-token-123',
  JSON.stringify(rAuth));

// 6. No bypass: an UNAUTHENTICATED request to the routed prefix gets the SIWE
//    login challenge, NOT the security upstream.
const r6 = await get('/security/api/status');
// The login challenge is the React SPA shell (id="root") or, if the app isn't
// built, the dependency-free fallback ("Connect wallet"). Either way it must NOT
// be the routed upstream.
const isLoginChallenge = r6.body.includes('id="root"') || r6.body.includes('Connect wallet');
check('GET /security/... unauthenticated → login challenge (no bypass)',
  r6.status === 200 && isLoginChallenge && !r6.body.includes('UPSTREAM='),
  JSON.stringify({ status: r6.status, body: r6.body.slice(0, 60) }));

// 7. WS upgrade routes by the same table: /security/* → security upstream.
wsHits.length = 0;
const w1 = await wsProbe('/security/ws', cookie);
await sleep(50);
check('WS /security/ws → security upstream (same routing table)',
  w1 === 'upgrade' && wsHits.length === 1 && wsHits[0].id === 'security' && wsHits[0].url === '/security/ws',
  `${w1} hits=${JSON.stringify(wsHits)}`);

// 8. WS upgrade to an unrouted path → main upstream (catch-all).
wsHits.length = 0;
const w2 = await wsProbe('/api/pty', cookie);
await sleep(50);
check('WS /api/pty → main upstream (catch-all)',
  w2 === 'upgrade' && wsHits.length === 1 && wsHits[0].id === 'main' && wsHits[0].url === '/api/pty',
  `${w2} hits=${JSON.stringify(wsHits)}`);

// 9. No WS bypass: unauthenticated upgrade is dropped — no upstream is reached.
wsHits.length = 0;
const w3 = await wsProbe('/security/ws');
await sleep(50);
check('WS /security/ws unauthenticated → dropped (no upstream reached)',
  w3 !== 'upgrade' && wsHits.length === 0, `${w3} hits=${JSON.stringify(wsHits)}`);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
main.close();
security.close();
process.exit(fail === 0 ? 0 : 1);
