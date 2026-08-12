/**
 * crosspub/browser/context.mjs — 영속 브라우저 컨텍스트 (자동 게시용)
 *
 * ⚠ 리스크 고지: 브라우저 자동 게시는 각 플랫폼 약관의 회색·위반 지대다.
 * 2026-07-06 사용자가 계정 정지 리스크를 명시적으로 수용하고 결정함
 * (deep-interview R3 "공식 API만" 결정의 사용자 변경).
 *
 * 보안 설계: 비밀번호는 어디에도 저장하지 않는다. 최초 1회 헤디드 로그인으로
 * 생긴 세션 쿠키만 state/crosspub-browser-profile/ (git 제외)에 남는다.
 */
import { chromium } from 'playwright';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { browserProfileDir, sessionStatePath, REPO_ROOT } from '../lib.mjs';

/**
 * sudo 없는 WSL 환경 우회: chromium 이 요구하는 libnspr4/libnss3/libasound2 를
 * vendor/chromium-libs/root/ 에 root 없이 풀어두고 LD_LIBRARY_PATH 로 주입한다.
 * (메모리 [[headless-browser-diagnosis]] 의 .deb 우회 레시피.)
 */
function vendorLdPath() {
  const base = join(REPO_ROOT, 'vendor', 'chromium-libs', 'root');
  if (!existsSync(base)) return null;
  const parts = [
    join(base, 'usr', 'lib', 'x86_64-linux-gnu'),
    join(base, 'lib', 'x86_64-linux-gnu'),
  ].filter(existsSync);
  return parts.length ? parts.join(':') : null;
}

/** 영속 컨텍스트 오픈. headed=true 면 창을 띄운다(WSLg DISPLAY 필요). */
export async function openContext({ headed = false } = {}) {
  const profile = browserProfileDir();
  mkdirSync(profile, { recursive: true });

  const vendor = vendorLdPath();
  const env = vendor
    ? { ...process.env, LD_LIBRARY_PATH: [vendor, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') }
    : process.env;

  const ctx = await chromium.launchPersistentContext(profile, {
    headless: !headed,
    viewport: { width: 1440, height: 900 },
    locale: 'ko-KR',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    env,
  });

  // 영속 프로필이 못 남기는 세션 쿠키(TSSESSION 등)를 스냅샷에서 복원.
  const sp = sessionStatePath();
  if (existsSync(sp)) {
    try {
      const cookies = JSON.parse(readFileSync(sp, 'utf8')).cookies || [];
      if (cookies.length) await ctx.addCookies(cookies);
    } catch { /* 손상 스냅샷은 무시 — 로그인으로 재생성 */ }
  }
  return ctx;
}

/** 로그인 직후 세션 쿠키 포함 전체 상태를 스냅샷으로 저장 */
export async function saveSessionState(ctx) {
  const sp = sessionStatePath();
  mkdirSync(join(sp, '..'), { recursive: true });
  const state = await ctx.storageState();
  writeFileSync(sp, JSON.stringify(state), 'utf8');
  return sp;
}

/** 플랫폼별 로그인 상태 판별 — 세션 쿠키 존재 기준 (내용은 읽지 않음) */
export async function isLoggedIn(ctx, platform) {
  const cookies = await ctx.cookies();
  const has = (domainPart, names) =>
    cookies.some(c => c.domain.includes(domainPart) && names.includes(c.name) && c.value);
  switch (platform) {
    case 'tistory': return has('tistory.com', ['TSSESSION']);
    case 'velog':   return has('velog.io', ['access_token', 'refresh_token']);
    case 'medium':  return has('medium.com', ['sid']);
    default: throw new Error(`알 수 없는 플랫폼: ${platform}`);
  }
}

export const LOGIN_URLS = {
  tistory: 'https://www.tistory.com/auth/login',
  velog:   'https://velog.io',
  medium:  'https://medium.com/m/signin',
};

/**
 * 순수 함수: 티스토리 세션 판정 (단위테스트 대상).
 * 로그인 리다이렉트면 만료, 제목 에디터 있으면 유효.
 */
export function judgeTistorySession({ url, hasEditor }) {
  if (/auth\/login|accounts\.kakao/.test(url || '')) return { valid: false, reason: '로그인 페이지로 리다이렉트(세션 만료)' };
  return hasEditor ? { valid: true } : { valid: false, reason: '제목 에디터 미표시(세션 만료 추정)' };
}

/**
 * 세션 실검증 — 쿠키 유무(isLoggedIn)의 false positive(만료된 쿠키가 남아있음)를
 * 잡기 위해 실제 페이지를 로드해 로그인 리다이렉트 여부로 판정.
 * @returns {Promise<{valid:boolean, reason?:string}>}
 */
export async function verifySession(ctx, platform, blogHost) {
  const page = await ctx.newPage();
  try {
    if (platform === 'tistory') {
      const host = blogHost || 'thundo.tistory.com';
      await page.goto(`https://${host}/manage/newpost/?type=post`, { waitUntil: 'domcontentloaded', timeout: 40_000 });
      await page.waitForTimeout(2500);
      const hasEditor = await page.locator('textarea[placeholder*="제목"], #post-title-inp, .textarea_tit')
        .first().isVisible({ timeout: 5000 }).catch(() => false);
      return judgeTistorySession({ url: page.url(), hasEditor });
    }
    // 그 외 플랫폼: 쿠키 기반 판정으로 폴백
    const ok = await isLoggedIn(ctx, platform);
    return ok ? { valid: true } : { valid: false, reason: '세션 쿠키 없음' };
  } catch (e) {
    return { valid: false, reason: `검증 실패: ${e.message.slice(0, 80)}` };
  } finally {
    await page.close().catch(() => {});
  }
}
