// One-command local verification — NO docker, NO Hermes image, NO wallet.
// Spins up a mock upstream + the real gateway in-process, then runs the smoke
// checks against them.
//   cd gateway && npm install && node test/run-local.ts

// Config must be set BEFORE importing the gateway (config.ts reads it at load).
process.env.PORT = process.env.PORT || '8080';
process.env.HERMES_TARGET = 'http://127.0.0.1:9999';
process.env.WALLET_DOMAIN = 'localhost:8080';
process.env.COOKIE_SECURE = 'false';
process.env.WALLET_CHAIN_ID = '1';
process.env.WALLET_SESSION_SECRET = 'local-dev-secret-not-for-production-0123456789abcdef';
process.env.WALLET_WHITELIST = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

import http from 'node:http';
import { runChecks } from './checks.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Mock upstream standing in for the Hermes dashboard.
const mock = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`MOCK_UPSTREAM_OK ${req.method} ${req.url}`);
});
await new Promise<void>((r) => mock.listen(9999, r));

// Importing server.ts starts the gateway (top-level server.listen()).
await import('../src/server.ts');

// Wait for readiness.
const base = `http://localhost:${process.env.PORT}`;
let ready = false;
for (let i = 0; i < 50; i++) {
  try {
    const h = await fetch(`${base}/healthz`);
    if (h.ok) {
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

const { fail } = await runChecks(base);
mock.close();
process.exit(fail === 0 ? 0 : 1);
