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
import { matchRoute } from './routing.ts';
import { SESSION_COOKIE, verifySession, mintCookie, clearCookie } from './session.ts';
import { issueNonce, verifyLogin } from './siwe.ts';
import { makeLoginStatic } from './static.ts';
import { renderLoginPage } from './login-page.ts';
import { parseCookies, clientIp } from './util.ts';

// The built React login app. Overridable via LOGIN_DIST (set in the image).
const LOGIN_DIST =
  process.env.LOGIN_DIST || fileURLToPath(new URL('../../login-app/dist', import.meta.url));
const loginStatic = makeLoginStatic(LOGIN_DIST, {
  chainId: config.chainId,
  wcProjectId: config.wcProjectId,
});
if (!loginStatic.hasBuild) {
  console.warn(`[gateway] login app not built at ${loginStatic.distDir}; serving fallback page.`);
  console.warn('[gateway] build it:  cd login-app && npm install && npm run build');
}

// One proxy instance; the upstream is chosen per-request via { target } (see
// resolveTarget). ws + xfwd are instance options and are inherited by every
// proxy.web / proxy.ws call.
const proxy = httpProxy.createProxyServer({
  ws: true,
  xfwd: true, // forward X-Forwarded-* so the upstream sees the real proto/host
});

// Pick the upstream for a request path: the longest matching GATEWAY_ROUTES
// prefix, else the HERMES_TARGET catch-all (null if none configured).
//
// NO-REWRITE CONTRACT: the matched path is forwarded to the upstream UNTOUCHED —
// the gateway never strips or rewrites the route prefix. Each upstream is mounted
// at its own base path (e.g. the security dashboard builds with SvelteKit
// paths.base="/security"), which is what makes a shared origin work. Do NOT add
// prefix-stripping here; it would silently break every routed upstream.
function resolveTarget(pathname: string): string | null {
  const route = matchRoute(pathname, config.routes);
  return route ? route.target : config.hermesTarget;
}

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
  // Auth runs BEFORE routing and applies uniformly: every proxied path shares
  // the one SIWE perimeter, so a routed prefix is never an auth bypass — an
  // unauthenticated request to /security gets the same login challenge as one to /.
  if (!sessionFrom(req)) {
    return serveLogin(res);
  }
  const target = resolveTarget(pathname);
  if (!target) {
    res.writeHead(502, { 'content-type': 'text/plain' });
    return res.end('No upstream configured for this path.');
  }
  proxy.web(req, res, { target });
});

// WebSocket upgrades (Hermes dashboard: /api/pty, /api/ws, /api/pub, /api/events).
// Browsers can't set Authorization on a WS upgrade, but they DO send cookies.
// Same gate, same routing table as HTTP: auth first, then longest-prefix target
// (no rewrite). No target -> destroy the socket (don't hang the upgrade).
server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  if (!sessionFrom(req)) {
    socket.destroy();
    return;
  }
  let pathname: string;
  try {
    pathname = new URL(req.url ?? '/', 'http://internal').pathname;
  } catch {
    socket.destroy();
    return;
  }
  const target = resolveTarget(pathname);
  if (!target) {
    socket.destroy();
    return;
  }
  proxy.ws(req, socket, head, { target });
});

server.listen(config.port, () => {
  const catchAll = config.hermesTarget ?? '(no catch-all)';
  const routeNote = config.routes.length
    ? `, routes=${config.routes.map((r) => `${r.prefix}->${r.target}`).join(' ')}`
    : '';
  console.log(
    `hermes-wallet-gateway listening on :${config.port} -> ${catchAll}${routeNote} ` +
      `(domains=${[...config.domains].join(',')}, chainId=${config.chainId}, ${config.whitelist.size} allowed)`,
  );
});
