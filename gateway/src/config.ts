// Runtime configuration, resolved from environment variables.
//
// In production these come from ROFL secrets (`oasis rofl secret set ...`),
// which the TEE injects as env vars. For local dev they come from a .env file
// loaded by `docker compose` (see ../../.env.example).

import { normalizePrefix, type Route } from './routing.ts';

function required(name: string): string {
  const v = (process.env[name] ?? '').trim();
  if (!v) {
    console.error(`FATAL: ${name} is required but not set.`);
    process.exit(1);
  }
  return v;
}

function fatal(message: string): never {
  console.error(`FATAL: ${message}`);
  process.exit(1);
}

// An upstream target must be a bare http/https ORIGIN (scheme://host[:port]) —
// the request path is forwarded untouched, so a target carrying its own path,
// query, or fragment would be silently prepended by http-proxy and break the
// no-rewrite contract. Reject those at startup rather than mis-route at runtime.
// Embedded credentials (userinfo) are also rejected: they'd leak into the startup
// log (which prints targets) and aren't how upstreams authenticate here — use
// headers instead.
function isUpstreamUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return (
      (u.protocol === 'http:' || u.protocol === 'https:') &&
      (u.pathname === '/' || u.pathname === '') &&
      u.search === '' &&
      u.hash === '' &&
      u.username === '' &&
      u.password === ''
    );
  } catch {
    return false;
  }
}

// GATEWAY_ROUTES: a JSON object mapping a path prefix to an upstream URL, e.g.
// {"/security":"http://hermes-security-dashboard:3000"}. Parsed and validated at
// startup; any malformed JSON, non-object shape, bad prefix, or non-URL value is
// fatal (fail fast). Unset/empty => no extra routes (legacy single-target mode).
function parseRoutes(raw: string | undefined): Route[] {
  if (raw === undefined || raw.trim() === '') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fatal(`GATEWAY_ROUTES is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fatal('GATEWAY_ROUTES must be a JSON object mapping "/prefix" -> "http://upstream".');
  }

  const routes: Route[] = [];
  const seen = new Set<string>();
  for (const [prefix, target] of Object.entries(parsed as Record<string, unknown>)) {
    if (!prefix.startsWith('/')) {
      fatal(`GATEWAY_ROUTES prefix ${JSON.stringify(prefix)} must start with "/".`);
    }
    if (!isUpstreamUrl(target)) {
      fatal(
        `GATEWAY_ROUTES target for ${JSON.stringify(prefix)} must be a bare http(s) origin ` +
          `with no path (got ${JSON.stringify(target)}).`,
      );
    }
    // Two keys can normalize to the same prefix ("/security" and "/security/").
    // That would create equal-length, order-dependent routes — reject it rather
    // than silently pick whichever JSON key came first.
    const normalized = normalizePrefix(prefix);
    if (seen.has(normalized)) {
      fatal(`GATEWAY_ROUTES has duplicate prefix ${JSON.stringify(normalized)} (after normalization).`);
    }
    seen.add(normalized);
    routes.push({ prefix: normalized, target });
  }
  return routes;
}

// The session-signing key. A STABLE secret is mandatory: a random per-process
// key would invalidate every session on restart and across replicas. Generate
// with `openssl rand -hex 32`.
const secret = Buffer.from(required('WALLET_SESSION_SECRET'), 'utf8');
if (secret.length < 32) {
  console.error('FATAL: WALLET_SESSION_SECRET must be at least 32 characters (use `openssl rand -hex 32`).');
  process.exit(1);
}

// The off-chain allowlist: comma-separated 0x addresses, normalized to
// lowercase. This is the v1 whitelist backend — swap is_allowed() (see
// siwe.ts) for a DB / token-gate / Sapphire read later without touching auth.
const whitelist = new Set<string>(
  (process.env.WALLET_WHITELIST ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);
if (whitelist.size === 0) {
  console.error('FATAL: WALLET_WHITELIST is empty — nobody could sign in.');
  process.exit(1);
}

// The public host(s) the dashboard is served from (no scheme), e.g.
// "p8080.m1234.test-proxy-b.rofl.app" or your custom domain. Bound into the
// SIWE message `domain` field server-side to defeat phishing — NOT derived from
// a client-controlled Host header. Comma-separated to accept more than one host
// (apex + www in prod, or localhost + 127.0.0.1 in dev — different browser
// origins, different signed domains). The FIRST entry is canonical (publicUrl).
const domains = required('WALLET_DOMAIN')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const domain = domains[0];

export interface GatewayConfig {
  port: number;
  // The catch-all upstream for paths matching no GATEWAY_ROUTES prefix. Null
  // only when HERMES_TARGET is set to an explicitly empty value (routes-only,
  // no fallback) — an unmatched path then gets a 502 instead of being proxied.
  hermesTarget: string | null;
  routes: Route[];
  domain: string;
  domains: Set<string>;
  publicUrl: string;
  chainId: number;
  wcProjectId: string;
  statement: string;
  sessionTtlSeconds: number;
  nonceTtlSeconds: number;
  cookieSecure: boolean;
  secret: Buffer;
  whitelist: Set<string>;
}

// HERMES_TARGET is the catch-all upstream. Unset => the historical default, so
// with GATEWAY_ROUTES also unset every request still proxies here exactly as
// before (back-compat). Set but empty => no catch-all (routes-only). Validated
// as an http(s) origin when present, consistent with GATEWAY_ROUTES targets.
const hermesTargetRaw = process.env.HERMES_TARGET;
const hermesTarget =
  hermesTargetRaw === undefined ? 'http://hermes-dashboard:9119' : hermesTargetRaw.trim() || null;
if (hermesTarget !== null && !isUpstreamUrl(hermesTarget)) {
  fatal(`HERMES_TARGET must be a bare http(s) origin with no path (got ${JSON.stringify(hermesTarget)}).`);
}

const config: GatewayConfig = {
  port: Number(process.env.PORT || 8080),
  hermesTarget,
  routes: parseRoutes(process.env.GATEWAY_ROUTES),
  domain,
  domains: new Set(domains),
  publicUrl: process.env.WALLET_PUBLIC_URL || `https://${domain}`,
  chainId: Number(process.env.WALLET_CHAIN_ID || 1),
  // WalletConnect/Reown project id, injected into the login app at runtime so one
  // built image serves any deployment (empty = WalletConnect/mobile QR disabled).
  wcProjectId: process.env.WALLET_WC_PROJECT_ID || '',
  statement: process.env.WALLET_STATEMENT || 'Sign in to the Hermes dashboard.',
  sessionTtlSeconds: Number(process.env.WALLET_SESSION_TTL || 12 * 60 * 60),
  nonceTtlSeconds: Number(process.env.WALLET_NONCE_TTL || 5 * 60),
  // Behind the ROFL proxy (terminate-tls) the browser↔proxy hop is HTTPS, so
  // Secure cookies are correct. Set COOKIE_SECURE=false only for local http dev.
  cookieSecure: (process.env.COOKIE_SECURE || 'true') !== 'false',
  secret,
  whitelist,
};

export default config;
