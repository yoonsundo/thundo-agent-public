/**
 * server/accountPassword.ts — 비밀번호 변경 핵심 로직 (서버 전용, 순수·주입식)
 *
 * 설계 의도:
 *   - 런타임 import 0개(타입만 import) → node 네이티브 TS strip-types 로 스모크 테스트에서
 *     그대로 import 가능. scrypt(verify/hash)는 deps 로 주입해 crypto 결합을 라우트로 밀어냄.
 *   - SERVICE_ROLE Supabase 클라이언트는 라우트에서만 생성·주입. 이 모듈은 db 를 받기만 한다.
 *
 * 계약: 반환 status 는 그대로 HTTP 상태코드로 쓴다.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/** 비밀번호 정책 경계. scrypt 는 길이 제한이 없지만 과도한 입력을 막아 자원낭비/오용 방지. */
export const PW_MIN = 8;
export const PW_MAX = 72;

/** 새 비밀번호 정책 검증. 통과면 null, 실패면 한국어 사유 문자열. */
export function validateNewPassword(next: string, current: string): string | null {
  if (typeof next !== 'string' || next.length < PW_MIN) {
    return `새 비밀번호는 ${PW_MIN}자 이상이어야 합니다.`;
  }
  if (next.length > PW_MAX) {
    return `새 비밀번호는 ${PW_MAX}자 이하여야 합니다.`;
  }
  if (next === current) {
    return '새 비밀번호가 기존 비밀번호와 같습니다.';
  }
  return null;
}

export interface PwDeps {
  /** 평문 vs 저장해시 검증 (authScrypt.verifyPassword) */
  verify: (password: string, stored: string) => boolean;
  /** 평문 → 'salt:hex' 저장형 (authScrypt.hashPassword) */
  hash: (password: string) => string;
}

export interface PwResult {
  ok: boolean;
  /** HTTP 상태코드로 그대로 사용 */
  status: number;
  error?: string;
}

/**
 * changePassword — 현재 비밀번호 검증 후 admin_users.password_hash 갱신.
 * @param db      SERVICE_ROLE Supabase 클라이언트(라우트에서 주입)
 * @param userId  세션 사용자 id (== admin_users.id)
 */
export async function changePassword(
  db: Pick<SupabaseClient, 'from'>,
  userId: string,
  currentPassword: string,
  newPassword: string,
  deps: PwDeps,
): Promise<PwResult> {
  if (!userId) {
    return { ok: false, status: 401, error: '세션 정보가 올바르지 않습니다.' };
  }
  if (!currentPassword || !newPassword) {
    return { ok: false, status: 400, error: '현재 비밀번호와 새 비밀번호를 모두 입력하세요.' };
  }

  const invalid = validateNewPassword(newPassword, currentPassword);
  if (invalid) {
    return { ok: false, status: 400, error: invalid };
  }

  // 현재 사용자 행 조회 (id 로 단건).
  const { data, error } = await db
    .from('admin_users')
    .select('id, password_hash')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    return { ok: false, status: 500, error: '계정 조회 중 오류가 발생했습니다.' };
  }
  if (!data) {
    // env 폴백 관리자 등 DB 행이 없는 계정은 변경 대상이 아니다(정직 처리).
    return { ok: false, status: 409, error: 'DB 계정이 아니어서 비밀번호를 변경할 수 없습니다.' };
  }

  // 현재 비밀번호 검증 — 실패 사유를 '조회 실패'와 구분하지 않고 동일 문구로 노출(열거 방지).
  if (!deps.verify(currentPassword, data.password_hash as string)) {
    return { ok: false, status: 400, error: '현재 비밀번호가 올바르지 않습니다.' };
  }

  const newHash = deps.hash(newPassword);
  const { error: updateError } = await db
    .from('admin_users')
    .update({ password_hash: newHash })
    .eq('id', userId);

  if (updateError) {
    return { ok: false, status: 500, error: '비밀번호 저장에 실패했습니다.' };
  }

  return { ok: true, status: 200 };
}
