// Path-prefix routing for the one-perimeter, many-upstreams gateway.
//
// A single SIWE auth gate (see server.ts) fans out to multiple upstreams by URL
// path prefix: GATEWAY_ROUTES maps "/prefix" -> "http://upstream", and anything
// matching no prefix falls back to HERMES_TARGET. The match is pure and lives
// here so it can be unit-tested in isolation from the proxy plumbing.

export interface Route {
  // Normalized path prefix: starts with "/", no trailing slash (except "/").
  prefix: string;
  // Validated upstream origin (http/https). The request path is forwarded
  // UNTOUCHED, so targets are bare origins (scheme://host:port) — see the
  // no-rewrite contract documented at the proxy call site in server.ts.
  target: string;
}

// Drop trailing slashes so "/security" and "/security/" are equivalent. A prefix
// that is all slashes (e.g. "/" or "//") collapses to "/" rather than to the
// empty string — an empty prefix would silently match every path.
export function normalizePrefix(prefix: string): string {
  const trimmed = prefix.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

// Longest-prefix, BOUNDARY-AWARE match. A route prefix "/security" matches the
// pathname "/security" and "/security/..." but NOT "/securityx" — the match
// only succeeds on a full path-segment boundary. When several prefixes match,
// the longest one wins. Returns null when no route matches.
export function matchRoute(pathname: string, routes: Route[]): Route | null {
  let best: Route | null = null;
  for (const route of routes) {
    const { prefix } = route;
    const matches = pathname === prefix || pathname.startsWith(prefix + '/');
    if (matches && (best === null || prefix.length > best.prefix.length)) {
      best = route;
    }
  }
  return best;
}
