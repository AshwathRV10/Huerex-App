import { Secret, TOTP } from 'otpauth';

const ISSUER = 'HUEREX GFES';

export function generateSecret(): string {
  return new Secret({ size: 20 }).base32;
}

export function otpauthUrl(username: string, secret: string): string {
  return new TOTP({ issuer: ISSUER, label: username, secret: Secret.fromBase32(secret) }).toString();
}

/** One step of tolerance either side, for clocks that drift on a LAN box. */
export function verifyTotp(secret: string, token: string): boolean {
  if (!/^\d{6}$/.test(token.trim())) return false;
  const totp = new TOTP({ issuer: ISSUER, secret: Secret.fromBase32(secret) });
  return totp.validate({ token: token.trim(), window: 1 }) !== null;
}
