// Startup validation checks. Runs src/config.ts as a subprocess (it parses +
// validates env at module load, then exits — no server) and asserts that good
// config exits 0 while malformed GATEWAY_ROUTES / HERMES_TARGET fails fast with
// a non-zero exit and a clear message.
//
//   cd gateway && npm install && node test/config-validation.ts

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const gatewayDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal env that satisfies every OTHER required field, so each case isolates
// the GATEWAY_ROUTES / HERMES_TARGET validation under test.
const baseEnv: Record<string, string> = {
  WALLET_SESSION_SECRET: 'local-dev-secret-not-for-production-0123456789abcdef',
  WALLET_WHITELIST: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  WALLET_DOMAIN: 'localhost:8080',
};

function loadConfig(overrides: Record<string, string | undefined>): { status: number; stderr: string } {
  const env: Record<string, string> = { ...process.env as Record<string, string>, ...baseEnv };
  // Start from a clean slate for the vars under test, then apply overrides.
  delete env.GATEWAY_ROUTES;
  delete env.HERMES_TARGET;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const r = spawnSync('node', ['src/config.ts'], { cwd: gatewayDir, env, encoding: 'utf8' });
  return { status: r.status ?? -1, stderr: r.stderr ?? '' };
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

console.log('\nconfig validation checks\n');

// Legacy: no GATEWAY_ROUTES, default HERMES_TARGET → valid (back-compat).
const legacy = loadConfig({});
check('GATEWAY_ROUTES unset → starts (legacy single-target)', legacy.status === 0, `status=${legacy.status}`);

// Valid routes object → starts.
const ok = loadConfig({ GATEWAY_ROUTES: JSON.stringify({ '/security': 'http://sec:3000' }) });
check('valid GATEWAY_ROUTES → starts', ok.status === 0, `status=${ok.status} ${ok.stderr}`);

// Routes-only (explicitly empty catch-all) → starts; unmatched paths 502 at runtime.
const routesOnly = loadConfig({ HERMES_TARGET: '', GATEWAY_ROUTES: JSON.stringify({ '/x': 'http://x:1' }) });
check('empty HERMES_TARGET + routes → starts (no catch-all)', routesOnly.status === 0, `status=${routesOnly.status} ${routesOnly.stderr}`);

const failsFast = (name: string, overrides: Record<string, string | undefined>, token = 'GATEWAY_ROUTES'): void => {
  const r = loadConfig(overrides);
  check(name, r.status !== 0 && r.stderr.includes(token), `status=${r.status} stderr=${r.stderr.trim()}`);
};

// Malformed JSON.
failsFast('malformed JSON → fail fast', { GATEWAY_ROUTES: '{not json' });
// Wrong shape: array, not an object.
failsFast('JSON array → fail fast', { GATEWAY_ROUTES: '["/security"]' });
// Wrong shape: scalar, not an object.
failsFast('JSON string → fail fast', { GATEWAY_ROUTES: '"nope"' });
// Prefix without a leading slash.
failsFast('prefix without "/" → fail fast', { GATEWAY_ROUTES: JSON.stringify({ security: 'http://s:3000' }) });
// Non-URL target.
failsFast('non-URL target → fail fast', { GATEWAY_ROUTES: JSON.stringify({ '/security': 'not a url' }) });
// Non-string target.
failsFast('non-string target → fail fast', { GATEWAY_ROUTES: '{"/security":123}' });
// Non-http(s) scheme.
failsFast('non-http scheme target → fail fast', { GATEWAY_ROUTES: JSON.stringify({ '/security': 'ftp://s/x' }) });
// Target carrying a path would be silently prepended by http-proxy (no-rewrite
// contract) — must be a bare origin.
failsFast('target with a path → fail fast', { GATEWAY_ROUTES: JSON.stringify({ '/security': 'http://s:3000/base' }) });
// Target with embedded credentials would leak into the startup log.
failsFast('target with userinfo → fail fast', { GATEWAY_ROUTES: JSON.stringify({ '/security': 'http://user:pass@s:3000' }) });
// Two keys normalizing to the same prefix produce order-dependent routes.
failsFast('duplicate normalized prefix → fail fast', { GATEWAY_ROUTES: JSON.stringify({ '/security': 'http://a:1', '/security/': 'http://b:2' }) });
// Invalid HERMES_TARGET (catch-all) also fails fast.
failsFast('invalid HERMES_TARGET → fail fast', { HERMES_TARGET: 'garbage' }, 'HERMES_TARGET');
// HERMES_TARGET with a path also fails fast (same bare-origin rule).
failsFast('HERMES_TARGET with a path → fail fast', { HERMES_TARGET: 'http://h:9119/base' }, 'HERMES_TARGET');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
