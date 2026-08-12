import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { E2E_NEXTAUTH_SECRET } from './secret';

/**
 * notices-hidden.spec.ts — SHOW_NOTICES=false 실측 (2026-07-30 공지 숨김 요청).
 *
 * 검증 계약:
 *  1) 공개 화면(홈·블로그) 어디에도 '/notices' 링크·공지 배너가 없다.
 *  2) 관리자 셸 사이드바에 '/admin/notices'('공지 관리') 메뉴가 없다.
 *  3) 라우트는 살아 있다 — /notices, /admin/notices 는 URL 직접 접근 시 정상 렌더.
 *     (/admin/notices 브레드크럼은 '공지 관리' 라벨을 유지해야 한다.)
 *  4) 나머지 메뉴 구성·이동은 그대로다.
 *
 * 관리자 세션: E2E 서버(playwright.config.ts webServer)와 같은 NEXTAUTH_SECRET 으로
 * next-auth JWT 를 직접 서명해 쿠키로 주입한다(로컬엔 Supabase 크리덴셜이 없어 실 로그인 불가).
 */

// 값을 여기에 박지 않는다 — config 와 공유하는 파생 상수를 쓴다(e2e/secret.ts 주석 참조).
const SECRET = E2E_NEXTAUTH_SECRET;

/** 무시할 콘솔 잡음 — kit.spec.ts 와 동일 기준(크리덴셜 없는 로컬에서 필연인 것만). */
const IGNORED_CONSOLE = [
  /favicon/i,
  /manifest\.json/i,
  /Failed to load resource.*40[134]/i,
  /Download the React DevTools/i,
  /NEXT_PUBLIC_SUPABASE/i,
  /supabase/i,
  /NEXTAUTH_SECRET/i,
  /\/api\/pv/i,
  /webpack-hmr/i,
  /WebSocket connection/i,
];

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (IGNORED_CONSOLE.some((re) => re.test(text))) return;
    errors.push(text);
  });
  page.on('pageerror', (err) => {
    if (IGNORED_CONSOLE.some((re) => re.test(err.message))) return;
    errors.push(`pageerror: ${err.message}`);
  });
  return errors;
}

/** middleware(getToken)·getServerSession 이 그대로 복호화하는 admin 세션 쿠키를 만든다. */
async function adminCookie(baseURL: string) {
  const token = await encode({
    token: { name: 'e2e-admin', email: 'e2e-admin@test.local', sub: 'e2e-admin', role: 'admin' },
    secret: SECRET,
    maxAge: 60 * 60,
  });
  const { hostname } = new URL(baseURL);
  return {
    name: 'next-auth.session-token', // http 환경 — __Secure- 접두어 없음
    value: token,
    domain: hostname,
    path: '/',
    httpOnly: true,
    sameSite: 'Lax' as const,
    expires: Math.floor(Date.now() / 1000) + 3600,
  };
}

test.describe('공개 화면 — 공지 노출 없음', () => {
  for (const path of ['/', '/blog']) {
    test(`${path} — /notices 링크·공지 배너가 없다`, async ({ page }) => {
      const errors = collectConsoleErrors(page);
      const res = await page.goto(path, { waitUntil: 'domcontentloaded' });
      expect(res?.status(), `${path} HTTP 상태`).toBeLessThan(400);
      await page.waitForLoadState('networkidle').catch(() => {});

      // 헤더·본문 어디에도 공지 링크가 없다
      await expect(page.locator('a[href="/notices"], a[href^="/notices/"]')).toHaveCount(0);
      // 홈 상단 고정 공지 배너 부재 (배너 텍스트 '공지'가 화면에 없어야 한다)
      await expect(page.locator('header, nav').getByText('공지사항')).toHaveCount(0);

      // 나머지 공개 메뉴는 그대로다
      for (const href of ['/', '/blog', '/videos']) {
        expect(
          await page.locator(`a[href="${href}"]`).count(),
          `${path} 에 ${href} 메뉴가 사라졌다`,
        ).toBeGreaterThan(0);
      }
      expect(errors, `콘솔 에러:\n${errors.join('\n')}`).toEqual([]);
    });
  }

  test('/notices — 라우트는 살아 있다 (URL 직접 접근)', async ({ page }) => {
    const res = await page.goto('/notices', { waitUntil: 'domcontentloaded' });
    expect(res?.status()).toBeLessThan(400);
    expect(page.url()).toMatch(/\/notices$/);
    await expect(page.locator('h1, h2, .page-title, .empty-title').first()).toContainText(/공지/);
  });
});

test.describe('관리자 셸 — 공지 관리 메뉴 숨김', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await context.addCookies([await adminCookie(baseURL!)]);
  });

  test('/admin — 사이드바에 공지 관리가 없고 나머지 메뉴는 그대로다', async ({ page }, testInfo) => {
    const errors = collectConsoleErrors(page);
    const res = await page.goto('/admin', { waitUntil: 'domcontentloaded' });
    expect(res?.status(), '/admin HTTP 상태').toBeLessThan(400);
    // 게이트 통과 확인 — 로그인으로 튕기면 아래 검사가 전부 무의미해진다
    expect(page.url(), '관리자 세션이 미들웨어를 통과해야 한다').toMatch(/\/admin$/);
    await page.waitForLoadState('networkidle').catch(() => {});

    const sidebar = page.locator('aside.sidebar');
    await expect(sidebar.locator('a[href="/admin/notices"]')).toHaveCount(0);
    await expect(sidebar.getByText('공지 관리')).toHaveCount(0);

    // 나머지 메뉴 전수 — 하나라도 빠지면 회귀
    const EXPECTED = [
      ['/admin', '대시보드'],
      ['/admin/projects', '프로젝트 관리'],
      ['/admin/portfolio', '포트폴리오 미리보기'],
      ['/admin/agents', '에이전트 관리'],
      ['/admin/chat', '에이전트 채팅'],
      ['/admin/orchestrator', '오케스트레이션 콘솔'],
      ['/admin/remediation', '자가 조치 승인'],
      ['/saju/amond', '아몬드 (사주 관제)'],
    ] as const;
    for (const [href, label] of EXPECTED) {
      const item = sidebar.locator(`a[href="${href}"]`);
      await expect(item, `${label}(${href}) 메뉴가 사라졌다`).toHaveCount(1);
      await expect(item).toContainText(label);
    }

    expect(errors, `콘솔 에러:\n${errors.join('\n')}`).toEqual([]);
    await page.screenshot({
      path: `e2e/screenshots/${testInfo.project.name}-admin-no-notices.png`,
      fullPage: true,
    });
  });

  test('/admin/projects — 사이드바 이동이 정상 동작한다', async ({ page }) => {
    await page.goto('/admin', { waitUntil: 'domcontentloaded' });
    const link = page.locator('aside.sidebar a[href="/admin/projects"]');
    await link.click();
    await page.waitForURL(/\/admin\/projects$/);
    await expect(link).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.crumb b')).toContainText('프로젝트 관리');
  });

  test('/admin/notices — 라우트는 살아 있고 브레드크럼 라벨을 유지한다', async ({ page }) => {
    const res = await page.goto('/admin/notices', { waitUntil: 'domcontentloaded' });
    expect(res?.status(), '/admin/notices HTTP 상태').toBeLessThan(400);
    expect(page.url(), '숨김은 메뉴만 — 라우트 접근은 유지돼야 한다').toMatch(/\/admin\/notices$/);

    // 메뉴에서 빠졌어도 브레드크럼은 '공지 관리'로 표기 (ALL_ITEMS 상시 포함 계약)
    await expect(page.locator('.crumb b')).toContainText('공지 관리');
    // 사이드바에는 여전히 없어야 한다
    await expect(page.locator('aside.sidebar a[href="/admin/notices"]')).toHaveCount(0);
  });
});

test.describe('비로그인 — 관리자 게이트 회귀 없음', () => {
  test('/admin/notices — 세션 없으면 /login 으로 보낸다', async ({ page }) => {
    await page.goto('/admin/notices', { waitUntil: 'domcontentloaded' });
    expect(page.url(), '비로그인 접근이 그대로 열렸다').toMatch(/\/login/);
  });
});
