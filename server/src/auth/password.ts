import { hash, verify } from '@node-rs/argon2';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';

// Argon2id, tuned so a login costs ~100ms on a small LAN box while staying
// painful for an offline attacker who gets hold of the .sqlite file.
const OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTS);
}

export async function verifyPassword(stored: string, plain: string): Promise<boolean> {
  try {
    return await verify(stored, plain, OPTS);
  } catch {
    return false;
  }
}

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Session ids are stored hashed, so a stolen database cannot be replayed. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface PasswordCheck { ok: boolean; problems: string[] }

export function checkPasswordStrength(pw: string, username = ''): PasswordCheck {
  const problems: string[] = [];
  if (pw.length < 10) problems.push('must be at least 10 characters');
  if (!/[a-z]/.test(pw)) problems.push('needs a lower-case letter');
  if (!/[A-Z]/.test(pw)) problems.push('needs an upper-case letter');
  if (!/[0-9]/.test(pw)) problems.push('needs a digit');
  if (username && pw.toLowerCase().includes(username.toLowerCase())) {
    problems.push('must not contain the username');
  }
  const common = ['password', '12345678', 'qwerty', 'huerex', 'admin123', 'welcome1'];
  if (common.some((c) => pw.toLowerCase().includes(c))) problems.push('is too easy to guess');
  return { ok: problems.length === 0, problems };
}
