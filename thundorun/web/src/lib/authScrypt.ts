/**
 * authScrypt.ts — 서버 전용 scrypt 비밀번호 유틸
 * 클라이언트 번들에 포함되지 않도록 server-only 로직만.
 * node:crypto 사용 (edge runtime 불가 — API route / 미들웨어 외부에서만).
 */
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

const SCRYPT_KEYLEN = 64;

/** hashPassword(pw) → "salt:derivedHex" */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `${salt}:${derived}`;
}

/** verifyPassword(pw, stored) → boolean. timingSafeEqual로 비교. */
export function verifyPassword(password: string, stored: string): boolean {
  if (!stored || !stored.includes(':')) return false;
  const [salt, expected] = stored.split(':');
  if (!salt || !expected) return false;
  let derived: Buffer;
  try {
    derived = scryptSync(password, salt, SCRYPT_KEYLEN);
  } catch {
    return false;
  }
  const expectedBuf = Buffer.from(expected, 'hex');
  if (expectedBuf.length !== derived.length) return false;
  return timingSafeEqual(derived, expectedBuf);
}

/** dummyVerify — 사용자 미존재 분기에서 타이밍 사이드채널 제거용 */
const DUMMY_HASH = `${'00'.repeat(16)}:${'ff'.repeat(64)}`;
export function dummyVerify(password: string): void {
  verifyPassword(password, DUMMY_HASH);
}
