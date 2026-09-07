/**
 * quiz-hidden.test.ts — /q 가 **어디에도 노출되지 않는지** 고정한다.
 *
 * 사용자 요구: "메인 홈에 띄우지 말고 url 로만". 링크가 어느 메뉴에 하나라도 걸리면
 * 요구가 깨지는데, 사람이 매번 눈으로 확인할 수는 없다. 그리고 이 저장소에서 이미
 * 겪었다 — nav 테스트가 상대 비교만 해서 항목이 옮겨 다녀도 조용히 통과했다.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PUBLIC_NAV, AUTH_NAV, ADMIN_NAV, navItemsFor } from '@/lib/nav';

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf8');

describe('/gogiiiii 노출 차단', () => {
  it('어떤 메뉴에도 링크가 없다', () => {
    const all = [...PUBLIC_NAV, ...AUTH_NAV, ADMIN_NAV].map((i) => i.href);
    expect(all).not.toContain('/gogiiiii');
  });

  it('로그인·관리자 어떤 상태에서도 메뉴에 뜨지 않는다', () => {
    for (const opts of [
      { isLoggedIn: false, isAdmin: false },
      { isLoggedIn: true, isAdmin: false },
      { isLoggedIn: true, isAdmin: true },
    ]) {
      expect(navItemsFor(opts).map((i) => i.href)).not.toContain('/gogiiiii');
    }
  });

  it('sitemap 에 넣지 않는다 — 검색에 걸리면 URL 로만 여는 의미가 없다', () => {
    expect(read('src/app/sitemap.ts')).not.toContain('/gogiiiii');
  });

  it('noindex 메타를 단다', () => {
    const page = read('src/app/gogiiiii/page.tsx');
    expect(page).toMatch(/robots:\s*'noindex/);
  });

  it('탭 제목이 퀴즈로 보이지 않는다 — 회사에서 여는 화면이다', () => {
    const page = read('src/app/gogiiiii/page.tsx');
    const title = page.match(/title:\s*'([^']+)'/)?.[1] ?? '';
    expect(title).toBeTruthy();
    for (const word of ['퀴즈', '게임', 'KBO', '야구', 'quiz', 'game']) {
      expect(title.includes(word), `탭 제목에 "${word}" 가 있으면 들킨다`).toBe(false);
    }
  });

  it('미들웨어가 /gogiiiii 를 로그인 뒤로 보내지 않는다', () => {
    const mw = read('src/middleware.ts');
    expect(mw).not.toContain("'/gogiiiii'");
    expect(mw).not.toContain("'/q/:path*'");
  });
});

describe('사이트 헤더 노출 차단', () => {
  /**
   * 화면 상단에 홈·블로그·관리자·로그아웃 메뉴줄이 떠 있으면 위장이 통째로 무의미하다
   * (2026-08 사용자 지적). `(site)` 그룹 레이아웃이 그 헤더를 붙이므로 라우트를 그룹 밖에 둔다.
   */
  it('(site) 그룹 밖에 있어 헤더·푸터가 붙지 않는다', () => {
    expect(() => read('src/app/gogiiiii/page.tsx')).not.toThrow();
    expect(() => read('src/app/(site)/gogiiiii/page.tsx'), '(site) 안으로 돌아가면 헤더가 붙는다')
      .toThrow();
  });

  it('페이지가 헤더 컴포넌트를 직접 부르지도 않는다', () => {
    const page = read('src/app/gogiiiii/page.tsx');
    expect(page).not.toContain('SiteHeader');
    expect(page).not.toContain('SiteFooter');
  });
});

describe('링크 전역 스캔', () => {
  /**
   * nav 배열만 보는 검사는 다른 컴포넌트에 하드코딩된 링크를 못 잡는다(리뷰 지적).
   * 소스 전체를 훑어 어디에도 링크가 없는지 본다 — 이 페이지 자신은 제외.
   */
  it('소스 어디에도 /gogiiiii 링크가 없다', () => {
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    const out = execSync(
      `grep -rn "gogiiiii" src --include=*.tsx --include=*.ts || true`,
      { encoding: 'utf8', cwd: process.cwd() },
    );
    const offenders = out.split('\n').filter(Boolean).filter((line) => {
      // 라우트 자신과 이 테스트는 당연히 언급한다.
      return !line.startsWith('src/app/gogiiiii/') && !line.startsWith('src/test/quiz-hidden');
    });
    expect(offenders, `링크가 남아 있다:\n${offenders.join('\n')}`).toEqual([]);
  });
});
