// Dependency-free fallback login page, served only when the React login app
// (login-app/dist) hasn't been built. Injected wallets only (no WalletConnect).
// The browser builds the EIP-4361 message by hand from server-injected config
// + a fetched nonce, then personal_signs it.

import { escapeHtml } from './util.ts';
import type { GatewayConfig } from './config.ts';

export function renderLoginPage(config: GatewayConfig): string {
  const statement = escapeHtml(config.statement);
  // Non-secret values the client needs to build the SIWE message.
  const cfg = JSON.stringify({ statement: config.statement, chainId: config.chainId });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in — Hermes</title>
<style>
  :root { --bg:#170d02; --amber:#ffac02; --fg:#fff; --hair:rgba(255,172,2,.22); }
  * { box-sizing:border-box; }
  html,body { margin:0; min-height:100%; background:var(--bg); color:var(--fg);
    font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  body { display:grid; place-items:center; padding:2rem 1.25rem; }
  main { width:100%; max-width:26rem; }
  .card { padding:2.25rem 2rem; background:color-mix(in srgb,#fff 2%,var(--bg));
    border:1px solid var(--hair);
    box-shadow:inset 1px 1px 0 rgba(255,255,255,.05), inset -1px -1px 0 rgba(0,0,0,.4),
      0 24px 60px -20px rgba(0,0,0,.6); }
  h1 { margin:0 0 .4rem; font-size:1.6rem; letter-spacing:.04em; text-transform:uppercase; }
  p.sub { margin:0 0 1.6rem; color:color-mix(in srgb,var(--fg) 65%,transparent); font-size:.95rem; }
  button { width:100%; padding:.95rem 1rem; background:var(--amber); color:var(--bg);
    font-weight:700; font-size:.8rem; letter-spacing:.16em; text-transform:uppercase;
    border:0; cursor:pointer; box-shadow:inset 1px 1px 0 rgba(255,255,255,.5),
      inset -1px -1px 0 rgba(0,0,0,.5); }
  button:hover { filter:brightness(1.08); }
  button:disabled { opacity:.6; cursor:default; }
  .err { margin-top:1rem; min-height:1.2em; color:#ff6b6b; font-size:.85rem; }
  .brand { text-align:center; margin-bottom:1.5rem; letter-spacing:.3em;
    text-transform:uppercase; color:var(--amber); font-size:.95rem; }
</style>
</head>
<body>
<main>
  <div class="brand">Hermes</div>
  <div class="card">
    <h1>Sign in</h1>
    <p class="sub">${statement}</p>
    <button id="connect" type="button">Connect wallet</button>
    <div class="err" id="err" role="alert"></div>
  </div>
</main>
<script>
(function () {
  var CFG = ${cfg};
  var btn = document.getElementById('connect');
  var err = document.getElementById('err');
  function fail(msg) { err.textContent = msg; btn.disabled = false; }
  function siweMessage(address, nonce) {
    var now = new Date();
    var exp = new Date(now.getTime() + 5 * 60 * 1000);
    return location.host + ' wants you to sign in with your Ethereum account:\\n'
      + address + '\\n\\n' + CFG.statement + '\\n\\n'
      + 'URI: ' + location.origin + '\\n'
      + 'Version: 1\\n'
      + 'Chain ID: ' + CFG.chainId + '\\n'
      + 'Nonce: ' + nonce + '\\n'
      + 'Issued At: ' + now.toISOString() + '\\n'
      + 'Expiration Time: ' + exp.toISOString();
  }
  btn.addEventListener('click', async function () {
    err.textContent = '';
    if (!window.ethereum) { fail('No Ethereum wallet found. Install a wallet extension.'); return; }
    btn.disabled = true;
    try {
      var accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      var address = accounts[0];
      var nres = await fetch('/siwe/nonce');
      if (!nres.ok) { fail('Could not start sign-in.'); return; }
      var nonce = (await nres.json()).nonce;
      var message = siweMessage(address, nonce);
      var signature = await window.ethereum.request({
        method: 'personal_sign', params: [message, address]
      });
      var vres = await fetch('/siwe/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: message, signature: signature }),
        credentials: 'same-origin'
      });
      if (vres.ok) { window.location.reload(); return; }
      if (vres.status === 401) { fail('This wallet is not on the allowlist.'); return; }
      if (vres.status === 429) { fail('Too many attempts. Please wait a moment.'); return; }
      fail('Sign-in failed. Please try again.');
    } catch (e) {
      fail(e && e.code === 4001 ? 'Signature request rejected.' : 'Sign-in error. Please try again.');
    }
  });
})();
</script>
</body>
</html>`;
}
