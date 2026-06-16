// Runtime configuration, resolved from environment variables.
//
// In production these come from ROFL secrets (`oasis rofl secret set ...`),
// which the TEE injects as env vars. For local dev they come from a .env file
// loaded by `docker compose` (see ../../.env.example).

function required(name: string): string {
  const v = (process.env[name] ?? '').trim();
  if (!v) {
    console.error(`FATAL: ${name} is required but not set.`);
    process.exit(1);
  }
  return v;
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
  hermesTarget: string;
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

const config: GatewayConfig = {
  port: Number(process.env.PORT || 8080),
  hermesTarget: process.env.HERMES_TARGET || 'http://hermes-dashboard:9119',
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
