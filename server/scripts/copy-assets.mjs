import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * TypeScript compiles .ts and ignores everything else, so the .sql migrations
 * would never reach dist/ and a built server would start against an empty
 * schema. This copies them across after every build.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'src', 'db', 'migrations');
const to = join(root, 'dist', 'db', 'migrations');

if (!existsSync(from)) {
  console.error(`No migrations at ${from}`);
  process.exit(1);
}
mkdirSync(dirname(to), { recursive: true });
cpSync(from, to, { recursive: true });
console.log(`  copied migrations to ${to}`);
