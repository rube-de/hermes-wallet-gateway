// hermes-wallet-gateway
//
// A small reverse proxy that turnstiles the Hermes dashboard behind a
// Sign-In-With-Ethereum + address-whitelist gate. Unauthenticated requests get
// the wallet-connect login app (RainbowKit/wagmi, built into login-app/dist);
// authenticated requests (and WebSocket upgrades) are proxied transparently to
// the internal Hermes dashboard.
//
// TLS and public ingress are handled by the ROFL port proxy, not here.
//
// Runs directly under Node's TypeScript type-stripping (Node >= 23.6 / the
// node:24-alpine image) — no build step.

import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import httpProxy from 'http-proxy';

import config from './config.ts';
import { SESSION_COOKIE, verifySession, mintCookie, clearCookie } from './session.ts';
import { issueNonce, verifyLogin } from './siwe.ts';
import { makeLoginStatic } from './static.ts';
import { renderLoginPage } from './login-page.ts';
import { parseCookies, clientIp } from './util.ts';

// The built React login app. Overridable via LOGIN_DIST (set in the image).
const LOGIN_DIST =
  process.env.LOGIN_DIST || fileURLToPath(new URL('../../login-app/dist', import.meta.url));
const loginStatic = makeLoginStatic(LOGIN_DIST);
if (!loginStatic.hasBuild) {
  console.warn(`[gateway] login app not built at ${loginStatic.distDir}; serving fallback page.`);
  console.warn('[gateway] build it:  cd login-app && npm install && npm run build');
}

const proxy = httpProxy.createProxyServer({
  target: config.hermesTarget,
  ws: true,
  xfwd: true, // forward X-Forwarded-* so Hermes sees the real proto/host
});

proxy.on('error', (err: Error, _req: IncomingMessage, res: ServerResponse | Duplex) => {
  console.error('proxy error:', err.message);
  if (res instanceof http.ServerResponse && !res.headersSent) {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('Upstream dashboard unavailable.');
  }
});

function sessionFrom(req: IncomingMessage): { address: string } | null {
  const token = parseCookies(req.headers.cookie || '')[SESSION_COOKIE];
  return token ? verifySession(token) : null;
}

function sendJson(
  res: ServerResponse,
  code: number,
  obj: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extraHeaders });
  res.end(JSON.stringify(obj));
}

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => {
      size += d.length;
      if (size > limit) {
        req.destroy();
        reject(new Error('payload too large'));
      } else {
        chunks.push(d);
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

// Per-IP sliding-window limiter for the verify endpoint (brute-force defense).
const RL_MAX = 10;
const RL_WINDOW_MS = 60_000;
const attempts = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const key = ip || '_unknown_';
  const recent = (attempts.get(key) || []).filter((t) => t > now - RL_WINDOW_MS);
  if (recent.length >= RL_MAX) {
    attempts.set(key, recent);
    return true;
  }
  recent.push(now);
  attempts.set(key, recent);
  return false;
}

function serveLogin(res: ServerResponse): void {
  if (loginStatic.hasBuild) return loginStatic.index(res);
  // Fallback (dependency-free) page if the React app wasn't built.
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(renderLoginPage(config));
}

const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://internal');
  } catch {
    return sendJson(res, 400, { error: 'bad request' });
  }
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }

  // Login-app static assets (public, content-hashed).
  if (pathname.startsWith('/__login/')) {
    return loginStatic.asset(req, res, pathname);
  }

  // --- SIWE handshake (public; no session required) ---
  if (req.method === 'GET' && pathname === '/siwe/nonce') {
    return sendJson(res, 200, { nonce: issueNonce() });
  }

  if (req.method === 'POST' && pathname === '/siwe/verify') {
    if (rateLimited(clientIp(req))) return sendJson(res, 429, { error: 'rate_limited' });
    let body: unknown;
    try {
      body = await readJson(req);
    } catch {
      return sendJson(res, 400, { error: 'bad body' });
    }
    try {
      const { address } = await verifyLogin(body as { message?: unknown; signature?: unknown });
      return sendJson(res, 200, { ok: true, address }, { 'set-cookie': mintCookie(address) });
    } catch {
      // Generic — never distinguish "not whitelisted" from "bad signature".
      return sendJson(res, 401, { error: 'unauthorized' });
    }
  }

  if (req.method === 'POST' && pathname === '/siwe/logout') {
    return sendJson(res, 200, { ok: true }, { 'set-cookie': clearCookie() });
  }

  // --- everything else: gated ---
  if (!sessionFrom(req)) {
    return serveLogin(res);
  }
  proxy.web(req, res);
});

// WebSocket upgrades (Hermes dashboard: /api/pty, /api/ws, /api/pub, /api/events).
// Browsers can't set Authorization on a WS upgrade, but they DO send cookies.
server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  if (!sessionFrom(req)) {
    socket.destroy();
    return;
  }
  proxy.ws(req, socket, head);
});

server.listen(config.port, () => {
  console.log(
    `hermes-wallet-gateway listening on :${config.port} -> ${config.hermesTarget} ` +
      `(domains=${[...config.domains].join(',')}, chainId=${config.chainId}, ${config.whitelist.size} allowed)`,
  );
});
