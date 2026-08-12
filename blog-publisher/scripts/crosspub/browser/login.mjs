#!/usr/bin/env node
/**
 * crosspub/browser/login.mjs — 최초 1회 수동 로그인 세션 확보 (헤디드)
 *
 * 사용: node scripts/crosspub/browser/login.mjs [tistory|velog|medium|all]
 *
 * 브라우저 창이 뜨면 사용자가 직접 로그인한다(비밀번호는 시스템에 저장 안 함).
 * 로그인 완료를 쿠키로 감지하면 다음 플랫폼으로 넘어간다. 세션은
 * state/crosspub-browser-profile/ 에 남아 이후 무인(headless) 게시에 재사용된다.
 */
import { makeLogger } from '../../lib/log.mjs';
import { openContext, saveSessionState, isLoggedIn, LOGIN_URLS } from './context.mjs';

const log = makeLogger('crosspub/login');
const ALL = ['tistory', 'velog', 'medium'];

/** 카카오/티스토리 '로그인 상태 유지' 체크박스가 뜨면 자동 체크(세션 수명 연장) */
async function tryKeepSignedIn(page) {
  try {
    const cb = page.locator('input[name="stay_signed_in"], input#stay_signed_in, label:has-text("로그인 상태 유지") input[type="checkbox"]').first();
    if (await cb.isVisible({ timeout: 500 }).catch(() => false) && !(await cb.isChecked().catch(() => true))) {
      await cb.check({ timeout: 1000 }).catch(() => {});
    }
  } catch { /* 없으면 무시 */ }
}

async function waitForLogin(ctx, page, platform, timeoutMs = 5 * 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (platform === 'tistory') await tryKeepSignedIn(page); // 세션 수명 연장(있을 때만)
    if (await isLoggedIn(ctx, platform)) return true;
    await page.waitForTimeout(2000);
  }
  return false;
}

async function main() {
  const arg = (process.argv[2] || 'all').toLowerCase();
  const targets = arg === 'all' ? ALL : [arg];
  if (targets.some(t => !ALL.includes(t))) {
    log.error(`Usage: login.mjs [${ALL.join('|')}|all]`);
    process.exit(2);
  }

  const ctx = await openContext({ headed: true });
  const page = await ctx.newPage();
  const results = {};

  for (const platform of targets) {
    if (await isLoggedIn(ctx, platform)) {
      log.info(`[${platform}] 이미 로그인됨 — 건너뜀`);
      results[platform] = 'already';
      continue;
    }
    log.info(`[${platform}] 로그인 페이지 오픈 — 브라우저 창에서 직접 로그인하세요 (최대 5분 대기)`);
    if (platform === 'tistory') log.info(`  💡 카카오 로그인 시 '로그인 상태 유지'를 체크하면 세션이 오래 유지됩니다(자동 체크 시도함).`);
    await page.goto(LOGIN_URLS[platform], { waitUntil: 'domcontentloaded' });
    const ok = await waitForLogin(ctx, page, platform);
    results[platform] = ok ? 'ok' : 'timeout';
    log[ok ? 'info' : 'error'](`[${platform}] ${ok ? '로그인 감지 — 세션 저장됨' : '시간 초과 — 다시 실행하세요'}`);
  }

  // 세션 쿠키까지 스냅샷 저장 → 이후 headless 재실행에서 복원 (TSSESSION 유지)
  await saveSessionState(ctx);
  log.info('세션 스냅샷 저장 — 이후 자동 게시에서 재사용');

  await ctx.close();
  process.stdout.write(JSON.stringify({ ok: Object.values(results).every(v => v !== 'timeout'), results }) + '\n');
  process.exit(Object.values(results).some(v => v === 'timeout') ? 1 : 0);
}

main().catch(e => { log.error(e.message); process.exit(2); });
