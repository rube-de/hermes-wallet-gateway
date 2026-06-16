// Run the smoke checks against an ALREADY-RUNNING gateway.
// Use with the docker-compose local stack:
//   docker compose -f compose.local.yml up --build -d
//   cd gateway && npm install && node test/smoke.ts
import { runChecks } from './checks.ts';

const base = process.env.GATEWAY_URL || 'http://localhost:8080';
const { fail } = await runChecks(base);
process.exit(fail === 0 ? 0 : 1);
