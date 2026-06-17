// Runs the full headless suite. Each file binds a port and reads env at load, so
// they run as separate subprocesses (sequentially) rather than in one process.
//   cd gateway && npm install && node test/all.ts

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = ['routing-unit.ts', 'run-local.ts', 'routing.ts', 'routes-only.ts', 'config-validation.ts'];

let failed = false;
for (const file of files) {
  console.log(`\n──── ${file} ────`);
  const r = spawnSync('node', [path.join(dir, file)], { stdio: 'inherit' });
  if (r.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
