import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEnvFile } from './env.js';

/**
 * .env.example has always told the operator to copy it to .env and point
 * DB_PATH somewhere outside the installation, so replacing the app folder on
 * an upgrade cannot take the factory's database and its backups with it.
 * Nothing read that file, so the instruction was a silent no-op. These guard
 * the reading of it — including the part that matters most for CI, Docker and
 * the test harness: a real environment variable still wins.
 */

function envFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'huerex-env-'));
  const path = join(dir, '.env');
  writeFileSync(path, body);
  return path;
}

test('reads plain keys, skipping blanks and comments', () => {
  const path = envFile([
    '# where things live',
    '',
    'DB_PATH=/var/lib/huerex/huerex.sqlite',
    '   ',
    'BACKUP_KEEP_DAILY=30',
  ].join('\n'));
  delete process.env.DB_PATH;
  delete process.env.BACKUP_KEEP_DAILY;

  loadEnvFile(path);

  assert.equal(process.env.DB_PATH, '/var/lib/huerex/huerex.sqlite');
  assert.equal(process.env.BACKUP_KEEP_DAILY, '30');
});

test('a real environment variable wins over the file', () => {
  const path = envFile('DB_PATH=/from/the/file.sqlite');
  process.env.DB_PATH = '/set/on/the/command/line.sqlite';

  loadEnvFile(path);

  assert.equal(process.env.DB_PATH, '/set/on/the/command/line.sqlite');
});

test('a missing file is not an error — most installs have no .env', () => {
  assert.doesNotThrow(() => loadEnvFile('/no/such/.env'));
});

test('quotes keep spaces, and an unquoted trailing comment is dropped', () => {
  const path = envFile([
    'BACKUP_DIR="D:/Huerex Backups"',
    "SESSION_COOKIE='huerex_sid'",
    'PORT=4000  # the LAN port',
  ].join('\n'));
  for (const k of ['BACKUP_DIR', 'SESSION_COOKIE', 'PORT']) delete process.env[k];

  loadEnvFile(path);

  assert.equal(process.env.BACKUP_DIR, 'D:/Huerex Backups');
  assert.equal(process.env.SESSION_COOKIE, 'huerex_sid');
  assert.equal(process.env.PORT, '4000');
});

test('a Windows file, an export prefix and a value containing = survive', () => {
  const path = envFile('export SEED_ADMIN_PASSWORD=a=b=c\r\nHOST=0.0.0.0\r\n');
  delete process.env.SEED_ADMIN_PASSWORD;
  delete process.env.HOST;

  loadEnvFile(path);

  assert.equal(process.env.SEED_ADMIN_PASSWORD, 'a=b=c');
  assert.equal(process.env.HOST, '0.0.0.0');
});
