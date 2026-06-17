// Pure-function unit tests for the routing primitives — no server, no network.
// Locks down boundary matching, longest-prefix tie-breaks, and prefix
// normalization (including degenerate "/" and "//" inputs).
//
//   cd gateway && npm install && node test/routing-unit.ts

import { matchRoute, normalizePrefix, type Route } from '../src/routing.ts';

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

console.log('\nrouting unit checks\n');

// --- normalizePrefix ---
const normCases: Array<[string, string]> = [
  ['/security', '/security'],
  ['/security/', '/security'],
  ['/security///', '/security'],
  ['/a/b/', '/a/b'],
  ['/', '/'],
  ['//', '/'],
  ['///', '/'],
];
for (const [input, want] of normCases) {
  const got = normalizePrefix(input);
  check(`normalizePrefix(${JSON.stringify(input)}) === ${JSON.stringify(want)}`, got === want, `got ${JSON.stringify(got)}`);
}

// --- matchRoute (prefixes are stored already-normalized) ---
const route = (prefix: string, target: string): Route => ({ prefix: normalizePrefix(prefix), target });
const routes: Route[] = [
  route('/security', 'http://sec:3000'),
  route('/security/admin', 'http://admin:3000'),
  route('/api', 'http://api:8080'),
];
const target = (pathname: string): string | null => matchRoute(pathname, routes)?.target ?? null;

check('exact prefix matches', target('/security') === 'http://sec:3000', target('/security') ?? 'null');
check('sub-path matches', target('/security/x') === 'http://sec:3000');
check('boundary: /securityx does NOT match /security', target('/securityx') === null, target('/securityx') ?? 'null');
check('boundary: /security-2 does NOT match', target('/security-2') === null, target('/security-2') ?? 'null');
check('longest prefix wins (/security/admin over /security)',
  target('/security/admin/users') === 'http://admin:3000', target('/security/admin/users') ?? 'null');
check('shorter prefix when longer does not reach boundary',
  target('/security/adminx') === 'http://sec:3000', target('/security/adminx') ?? 'null');
check('different prefix matches independently', target('/api/v1') === 'http://api:8080');
check('unmatched path → null', target('/dashboard') === null, target('/dashboard') ?? 'null');
check('root path unmatched by non-root prefixes', target('/') === null, target('/') ?? 'null');
check('empty route table → null', matchRoute('/anything', []) === null);

// A "/" route (normalized) is an exact-root route, never a wildcard catch-all.
const rootRoutes: Route[] = [route('/', 'http://root:1'), route('/security', 'http://sec:1')];
check('"/" route matches exact / only', matchRoute('/', rootRoutes)?.target === 'http://root:1');
check('"/" route does NOT swallow /security', matchRoute('/security', rootRoutes)?.target === 'http://sec:1');
check('"/" route does NOT swallow /other', matchRoute('/other', rootRoutes) === null);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
