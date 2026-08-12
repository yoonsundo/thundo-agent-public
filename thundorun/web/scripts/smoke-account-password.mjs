/**
 * smoke-account-password.mjs — changePassword 결정표 + 실제 scrypt 왕복 검증.
 *
 * 실행: (web/) node scripts/smoke-account-password.mjs
 * node v20.6+ 네이티브 TS strip-types 로 .ts 소스를 직접 import.
 * live DB 미접촉 — admin_users 행을 흉내내는 가짜 db 사용.
 */
import { hashPassword, verifyPassword } from '../src/lib/authScrypt.ts';
import { changePassword, validateNewPassword } from '../src/server/accountPassword.ts';

const deps = { verify: verifyPassword, hash: hashPassword };
let failures = 0;
function check(name, cond) {
  if (cond) { console.log(`  PASS  ${name}`); }
  else { console.log(`  FAIL  ${name}`); failures++; }
}

/** admin_users 한 행을 흉내내는 최소 Supabase 체인 목. */
function makeDb({ row, selectError = null, updateError = null }) {
  const captured = { updated: null };
  const api = {
    from() { return api; },
    select() { return api; },
    eq() { return api; },
    maybeSingle() { return Promise.resolve({ data: row, error: selectError }); },
    update(patch) { captured.updated = patch; return { eq: () => Promise.resolve({ error: updateError }) }; },
  };
  return { db: api, captured };
}

const USER = 'alice';
const CURRENT = 'oldPassw0rd';
const storedHash = hashPassword(CURRENT); // 실제 scrypt 'salt:hex'

console.log('# validateNewPassword 단위');
check('8자 미만 거부', validateNewPassword('short', CURRENT) !== null);
check('현재와 동일 거부', validateNewPassword(CURRENT, CURRENT) !== null);
check('유효 신규 통과(null)', validateNewPassword('brandNewPass1', CURRENT) === null);

console.log('# changePassword 결정표');

// (a) 정답 current + 유효 신규 → ok, 저장된 새 해시가 실제로 새 비번을 검증
{
  const { db, captured } = makeDb({ row: { id: USER, password_hash: storedHash } });
  const r = await changePassword(db, USER, CURRENT, 'brandNewPass1', deps);
  check('(a) 성공 ok:true status 200', r.ok === true && r.status === 200);
  check('(a) update 로 password_hash 기록됨', !!captured.updated && typeof captured.updated.password_hash === 'string');
  check('(a) 새 해시가 새 비번을 verify true', verifyPassword('brandNewPass1', captured.updated.password_hash) === true);
  check('(a) 새 해시가 옛 비번은 verify false', verifyPassword(CURRENT, captured.updated.password_hash) === false);
}

// (b) 오답 current → 400, update 미호출
{
  const { db, captured } = makeDb({ row: { id: USER, password_hash: storedHash } });
  const r = await changePassword(db, USER, 'WRONG-current', 'brandNewPass1', deps);
  check('(b) 오답 current → 400', r.ok === false && r.status === 400 && r.error === '현재 비밀번호가 올바르지 않습니다.');
  check('(b) update 미호출', captured.updated === null);
}

// (c) 8자 미만 신규 → 400, DB 조회 이전에 차단(update 미호출)
{
  const { db, captured } = makeDb({ row: { id: USER, password_hash: storedHash } });
  const r = await changePassword(db, USER, CURRENT, 'short', deps);
  check('(c) 8자 미만 → 400', r.ok === false && r.status === 400);
  check('(c) update 미호출', captured.updated === null);
}

// (d) 새 == 현재 → 400
{
  const { db } = makeDb({ row: { id: USER, password_hash: storedHash } });
  const r = await changePassword(db, USER, CURRENT, CURRENT, deps);
  check('(d) 새==현재 → 400', r.ok === false && r.status === 400);
}

// (e) admin_users 행 없음(env 폴백 관리자 등) → 409
{
  const { db } = makeDb({ row: null });
  const r = await changePassword(db, USER, CURRENT, 'brandNewPass1', deps);
  check('(e) 행 없음 → 409', r.ok === false && r.status === 409);
}

// (f) 빈 입력 → 400
{
  const { db } = makeDb({ row: { id: USER, password_hash: storedHash } });
  const r = await changePassword(db, USER, '', '', deps);
  check('(f) 빈 입력 → 400', r.ok === false && r.status === 400);
}

console.log(failures === 0 ? '\nALL SMOKE PASS' : `\n${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
