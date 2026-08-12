import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { registeredClasses } from '../src/test/kit';

/**
 * kit.spec.ts — 브라우저 실측 검수.
 *
 * 단위 테스트(design-guard)는 "소스에 금지 패턴이 없다"를 본다.
 * 여기서는 "실제로 렌더된 화면이 키트 토큰으로 그려졌다"를 본다 — computed style,
 * 콘솔 에러, 테마 전환, 모바일 뷰포트, 스크린샷.
 */

const SHOTS = path.join(__dirname, 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

/**
 * 로그인 없이 열리는 화면.
 *
 * `lands` 는 **실제로 도착해야 하는 경로**다. 이 확인이 없으면 모든 라우트가 조용히
 * 로그인 화면으로 리다이렉트돼도 "키트 토큰이 적용됐다"는 이유로 전부 통과한다
 * (실제로 그렇게 통과한 적이 있어 추가했다).
 * `heading` 은 그 화면의 고유 텍스트 — 페이지 정체성을 한 번 더 못박는다.
 */
const PUBLIC_ROUTES: Array<{ path: string; name: string; lands?: RegExp; heading?: RegExp }> = [
  { path: '/',        name: 'home',      lands: /\/$/ },
  { path: '/blog',    name: 'blog-list', lands: /\/blog$/,    heading: /블로그/ },
  { path: '/videos',  name: 'videos',    lands: /\/videos$/,  heading: /영상/ },
  { path: '/notices', name: 'notices',   lands: /\/notices$/, heading: /공지/ },
  { path: '/login',   name: 'login',     lands: /\/login/,    heading: /로그인/ },
];

/**
 * 로그인·코드 게이트가 걸린 화면 — 비로그인은 로그인/게이트로 보내는 것이 정상 동작이다.
 * (사주·타로·꿈·편집기는 도구 계열이라 이전부터 게이트 뒤에 있었다.)
 */
const GATED_ROUTES = [
  '/agents', '/reports', '/home', '/account', '/admin',
  '/saju', '/tarot', '/dream', '/run',
];

/** 무시할 콘솔 잡음 — 크리덴셜 없는 로컬 환경에서 필연적으로 나는 것만. */
const IGNORED_CONSOLE = [
  /favicon/i,
  /manifest\.json/i,
  /Failed to load resource.*40[34]/i,
  /Download the React DevTools/i,
  /NEXT_PUBLIC_SUPABASE/i,
  /supabase/i,
  /NEXTAUTH_SECRET/i,
  /\/api\/pv/i,          // 트래픽 집계 비콘 — 로컬엔 DB 없음
  /webpack-hmr/i,       // dev 서버 HMR 소켓 — 프로덕션엔 없음
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

/**
 * 렌더된 DOM 에 globals.css 에 없는 클래스가 붙어 있는지 검사.
 *
 * 허용 목록을 손으로 적으면 `.pt-safe` 같은 정당한 등재 확장까지 오탐한다.
 * 그래서 globals.css 를 실제로 파싱한 집합과 비교한다 — 단위 가드와 같은 출처다.
 */
const REGISTERED = [...registeredClasses()];

async function tailwindLeftovers(page: Page): Promise<string[]> {
  return page.evaluate((registered: string[]) => {
    const OK = new Set(registered);
    // 우리가 정의하지 않는 제3자 클래스
    //  - lucide-react 가 SVG 에 붙이는 `lucide lucide-<icon>` (아이콘 자체는 규칙 8 이 요구하는 것)
    //  - tiptap(ProseMirror) 이 에디터 본문에 붙이는 클래스
    const THIRD_PARTY = /^(lucide$|lucide-|ProseMirror|tippy|is-)/;
    const out = new Set<string>();
    document.querySelectorAll<HTMLElement>('[class]').forEach((el) => {
      el.classList.forEach((c) => {
        if (OK.has(c) || THIRD_PARTY.test(c)) return;
        out.add(c);
      });
    });
    return [...out];
  }, REGISTERED);
}

/**
 * 렌더된 텍스트에 남은 이모지·기하문자를 모은다 (규칙 8).
 * 소스 스캔은 데이터에서 흘러든 이모지를 볼 수 없으므로 여기서 실제 DOM 을 본다.
 */
async function renderedEmoji(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const RE = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2190}-\u{2BFF}\u{2600}-\u{27BF}]/gu;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const found = new Set<string>();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const parent = n.parentElement;
      if (!parent) continue;
      if (parent.closest('script, style, svg, noscript')) continue;
      for (const m of (n.nodeValue ?? '').matchAll(RE)) found.add(m[0]);
    }
    return [...found];
  });
}

/** 키트 토큰이 실제로 살아 있는지(파싱 실패·미로드 감지). */
async function kitTokens(page: Page) {
  return page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return {
      bg: cs.getPropertyValue('--color-bg').trim(),
      accent: cs.getPropertyValue('--color-accent').trim(),
      radiusMd: cs.getPropertyValue('--radius-md').trim(),
      headingFont: cs.getPropertyValue('--font-heading').trim(),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      theme: document.documentElement.getAttribute('data-theme'),
    };
  });
}

test.describe('공개 화면 — 키트 실측', () => {
  for (const route of PUBLIC_ROUTES) {
    test(`${route.path} — 렌더·토큰·콘솔·Tailwind 잔존`, async ({ page }, testInfo) => {
      const errors = collectConsoleErrors(page);
      const res = await page.goto(route.path, { waitUntil: 'domcontentloaded' });
      expect(res?.status(), `${route.path} HTTP 상태`).toBeLessThan(400);
      await page.waitForLoadState('networkidle').catch(() => { /* 스트리밍 페이지는 idle 안 옴 */ });

      // 0) 의도한 화면에 도착했는가 (조용한 리다이렉트로 통과하는 것을 막는다)
      if (route.lands) expect(page.url(), `${route.path} 최종 URL`).toMatch(route.lands);
      if (route.heading) {
        await expect(page.locator('h1, h2, .page-title, .empty-title').first()).toContainText(route.heading);
      }

      // 1) 키트 CSS 가 실제로 적용됐는가
      const tokens = await kitTokens(page);
      expect(tokens.theme, 'html[data-theme]').toBe('light');
      expect(tokens.bg.toLowerCase(), '--color-bg (라이트 기본)').toBe('#f3f2f2');
      expect(tokens.accent.toLowerCase(), '--color-accent').toBe('#ec3013');
      expect(tokens.radiusMd, '--radius-md').toBe('8px');
      expect(tokens.headingFont, '--font-heading 에 Archivo').toContain('Archivo');
      expect(tokens.bodyBg, 'body 배경이 토큰으로 그려짐').toBe('rgb(243, 242, 242)');

      // 2) Tailwind 잔존 0
      const leftovers = await tailwindLeftovers(page);
      expect(leftovers, `globals.css 에 없는 클래스: ${leftovers.join(', ')}`).toEqual([]);

      // 3) 이모지 0 — 소스 스캔이 못 잡는 "데이터로 흘러든 이모지"를 렌더 결과에서 잡는다
      //    (예: lib/tarotDeck.ts 의 카드 심볼). 규칙 8.
      const emojis = await renderedEmoji(page);
      expect(emojis, `렌더된 이모지: ${emojis.join(' ')}`).toEqual([]);

      // 4) 콘솔 에러 0
      expect(errors, `콘솔 에러:\n${errors.join('\n')}`).toEqual([]);

      // 5) 가로 스크롤 없음 — 좁은 화면에서 내비가 잘려 나가는 결함을 잡는다.
      //    (모바일 헤더에서 실제로 메뉴 라벨이 절단된 적이 있어 추가했다.)
      const overflow = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        inner: window.innerWidth,
        culprits: [...document.querySelectorAll<HTMLElement>('body *')]
          .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 2)
          .slice(0, 5)
          .map((el) => `${el.tagName.toLowerCase()}.${el.className}`.slice(0, 80)),
      }));
      expect(
        overflow.scroll,
        `가로 오버플로 (scrollWidth ${overflow.scroll} > innerWidth ${overflow.inner}) — ${overflow.culprits.join(' | ')}`,
      ).toBeLessThanOrEqual(overflow.inner + 1);

      // 6) 스크린샷 (사람 검수용)
      await page.screenshot({
        path: path.join(SHOTS, `${testInfo.project.name}-${route.name}.png`),
        fullPage: true,
      });
    });
  }
});

test.describe('한글 렌더 — 웹폰트 실제 로드', () => {
  test('Pretendard 가 실제로 로드돼 한글이 시스템 폴백으로 떨어지지 않는다', async ({ page }) => {
    // `--font-heading` 문자열만 보면 CDN 실패를 못 잡는다(리뷰 L3).
    // 실제 폰트 로딩 결과를 본다 — 이게 깨지면 한글이 두부(□)로 렌더된다.
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => document.fonts.ready);

    const fonts = await page.evaluate(() => ({
      pretendard: document.fonts.check('16px "Pretendard Variable"'),
      archivo: document.fonts.check('16px Archivo'),
      loaded: [...document.fonts].map((f) => `${f.family}:${f.status}`),
    }));
    expect(
      fonts.pretendard,
      `Pretendard 미로드 — 한글이 시스템 폴백으로 떨어진다. 로드된 폰트: ${fonts.loaded.join(', ')}`,
    ).toBe(true);
    expect(fonts.archivo, 'Archivo 미로드 — 라틴 제목이 폴백으로 떨어진다').toBe(true);
  });
});

test.describe('블로그 상세 — 본문 타이포(.article)', () => {
  test('목록에서 첫 글로 들어가 키트 본문으로 렌더된다', async ({ page }, testInfo) => {
    const errors = collectConsoleErrors(page);
    await page.goto('/blog', { waitUntil: 'domcontentloaded' });

    const first = page.locator('a[href^="/blog/"]').first();
    if ((await first.count()) === 0) {
      // 로컬엔 Supabase 크리덴셜이 없어 글 목록이 빈 경우가 있다. 조용히 통과시키지 않고 남긴다.
      test.skip(true, '발행된 글이 없어 상세 검사를 건너뜀 (Supabase 크리덴셜 없는 로컬 환경)');
      return;
    }

    await first.click();
    await page.waitForURL(/\/blog\/.+/);
    await page.waitForLoadState('networkidle').catch(() => {});

    // 본문은 반드시 .article 로 감싼다(prose 대체) — §11.3
    await expect(page.locator('.article').first()).toBeVisible();

    const tokens = await kitTokens(page);
    expect(tokens.bodyBg).toBe('rgb(243, 242, 242)');

    const leftovers = await tailwindLeftovers(page);
    expect(leftovers, `globals.css 에 없는 클래스: ${leftovers.join(', ')}`).toEqual([]);

    const emojis = await renderedEmoji(page);
    expect(emojis, `렌더된 이모지: ${emojis.join(' ')}`).toEqual([]);
    expect(errors, `콘솔 에러:\n${errors.join('\n')}`).toEqual([]);

    await page.screenshot({
      path: path.join(SHOTS, `${testInfo.project.name}-blog-post.png`),
      fullPage: true,
    });
  });
});

test.describe('로그인 게이트', () => {
  for (const p of GATED_ROUTES) {
    test(`${p} — 비로그인은 /login 으로 보낸다`, async ({ page }) => {
      await page.goto(p, { waitUntil: 'domcontentloaded' });
      // 로그인 페이지 또는 해당 버티컬의 전용 게이트(예: /saju/gate) 로 보내야 한다.
      expect(page.url(), `${p} 는 게이트로 가야 한다`).toMatch(/\/(login|gate)/);
      expect(page.url(), `${p} 가 그대로 열렸다 — 게이트 미작동`).not.toBe(`${new URL(page.url()).origin}${p}`);
    });
  }
});

test.describe('테마 전환 (§9)', () => {
  test('토글 한 번으로 다크 토큰이 적용되고 새로고침 후에도 유지된다', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const toggle = page.getByRole('button', { name: '다크 모드로 전환' });
    await expect(toggle).toBeVisible();

    // dev 서버는 요청 시 컴파일하므로 하이드레이션 완료 시점이 늦다.
    // 이미 dark 면 누르지 않는 멱등 재시도로 "하이드레이션 전 클릭" flake 를 없앤다.
    await expect(async () => {
      if ((await kitTokens(page)).theme !== 'dark') await toggle.click();
      expect((await kitTokens(page)).theme).toBe('dark');
    }).toPass({ timeout: 30_000 });

    const dark = await kitTokens(page);
    expect(dark.theme).toBe('dark');
    expect(dark.bg.toLowerCase()).toBe('#1a1918');
    expect(dark.bodyBg).toBe('rgb(26, 25, 24)');

    await page.screenshot({ path: path.join(SHOTS, 'home-dark.png'), fullPage: true });

    // 저장된 선택이 새로고침 후에도 살아있는가(FOUC 방지 스크립트)
    await page.reload({ waitUntil: 'domcontentloaded' });
    expect((await kitTokens(page)).theme).toBe('dark');
  });
});

test.describe('규칙 4.4 · 5 — 강조 절제', () => {
  for (const route of PUBLIC_ROUTES) {
    test(`${route.path} — 화면당 .btn-primary 는 최대 1개`, async ({ page }) => {
      await page.goto(route.path, { waitUntil: 'domcontentloaded' });
      const primaries = await page.evaluate(() =>
        [...document.querySelectorAll('.btn-primary')].map((b) => b.textContent?.trim() ?? ''),
      );
      expect(primaries.length, `primary 버튼 ${primaries.length}개: ${primaries.join(' / ')}`)
        .toBeLessThanOrEqual(1);
    });
  }
});

test.describe('접근성 계약 (§8)', () => {
  test('아이콘 전용 버튼에 aria-label 이 있다', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const unlabeled = await page.evaluate(() =>
      [...document.querySelectorAll('button.btn-icon')]
        .filter((b) => !b.getAttribute('aria-label')?.trim())
        .map((b) => b.outerHTML.slice(0, 120)),
    );
    expect(unlabeled, `aria-label 없는 아이콘 버튼:\n${unlabeled.join('\n')}`).toEqual([]);
  });

  test('활성 내비가 aria-current="page" 로 표시된다', async ({ page }) => {
    await page.goto('/blog', { waitUntil: 'domcontentloaded' });
    const current = await page.locator('[aria-current="page"]').count();
    expect(current, '활성 메뉴 표시가 없다').toBeGreaterThan(0);
  });

  test('포커스 링을 제거하지 않았다', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await page.keyboard.press('Tab');
    const outline = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { width: cs.outlineWidth, style: cs.outlineStyle };
    });
    expect(outline).not.toBeNull();
    expect(outline!.style, '포커스 링 제거됨').not.toBe('none');
  });
});
