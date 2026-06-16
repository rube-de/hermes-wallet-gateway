// Dev server for a BROWSER wallet test: starts a friendly mock "dashboard"
// upstream + the real gateway with local-http-friendly settings, and stays
// running. No Hermes image needed.
//
// For the full RainbowKit UI (injected + WalletConnect/mobile), build the
// login app first; otherwise the gateway serves a dependency-free fallback.
//
//   cd login-app && npm install && npm run build && cd ../gateway && npm install
//   WALLET_WHITELIST=0xYourWalletAddress node test/dev.ts
//   # then open http://localhost:8080 and connect a wallet

process.env.PORT ||= '8080';
process.env.HERMES_TARGET ||= 'http://127.0.0.1:9999';
process.env.WALLET_DOMAIN ||= 'localhost:8080';
process.env.COOKIE_SECURE ||= 'false'; // required for plain-http localhost
process.env.WALLET_CHAIN_ID ||= '1';
process.env.WALLET_SESSION_SECRET ||= 'local-dev-secret-not-for-production-0123456789abcdef';

if (!process.env.WALLET_WHITELIST) {
  console.error('\nSet WALLET_WHITELIST to your wallet address first, e.g.:');
  console.error('  WALLET_WHITELIST=0xYourAddress node test/dev.ts\n');
  process.exit(1);
}

import http from 'node:http';

// A friendly stand-in for the Hermes dashboard. You only reach it AFTER a
// successful wallet login — so seeing this page proves the gate works.
const mock = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Mock dashboard</title>
<style>body{font-family:system-ui;background:#170d02;color:#fff;display:grid;place-items:center;height:100vh;margin:0}
.card{border:1px solid rgba(255,172,2,.3);padding:2rem 2.5rem;text-align:center}
h1{color:#ffac02} code{color:#ffac02} button{margin-top:1rem;padding:.6rem 1.2rem;cursor:pointer}</style></head>
<body><div class="card"><h1>✅ Authenticated</h1>
<p>Your wallet passed the allowlist gate and reached the (mock) dashboard.</p>
<p><code>${req.method} ${req.url}</code></p>
<button onclick="fetch('/siwe/logout',{method:'POST'}).then(()=>location.reload())">Log out</button>
</div></body></html>`);
});
mock.listen(9999, () => console.log('mock upstream (stand-in dashboard) on :9999'));

// Importing server.ts starts the gateway (top-level server.listen()).
await import('../src/server.ts');

console.log('\n────────────────────────────────────────────────');
console.log(`  open  http://localhost:${process.env.PORT}`);
console.log(`  whitelisted: ${process.env.WALLET_WHITELIST}`);
console.log('  connect a wallet, sign, and you should land on the mock dashboard.');
console.log('  Ctrl-C to stop.');
console.log('────────────────────────────────────────────────\n');
