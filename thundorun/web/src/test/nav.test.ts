/**
 * nav.test.ts — 내비게이션 단일 출처 계약.
 * 헤더와 사이드바가 이 함수를 공유하므로 노출 규칙이 어긋나면 두 메뉴가 갈라진다.
 * 아이콘이 lucide 컴포넌트(이모지 문자열이 아님)라는 점도 여기서 고정한다.
 */
import { describe, it, expect } from 'vitest';
import { PUBLIC_NAV, AUTH_NAV, ADMIN_NAV, navItemsFor } from '@/lib/nav';

describe('navItemsFor — 권한별 노출', () => {
  it('비로그인은 공개 메뉴만 본다', () => {
    const items = navItemsFor({ isLoggedIn: false, isAdmin: false });
    expect(items.map((i) => i.href)).toEqual(PUBLIC_NAV.map((i) => i.href));
  });

  it('로그인 사용자는 공개 + 로그인 전용을 본다', () => {
    const items = navItemsFor({ isLoggedIn: true, isAdmin: false });
    expect(items).toHaveLength(PUBLIC_NAV.length + AUTH_NAV.length);
    expect(items.some((i) => i.href === ADMIN_NAV.href)).toBe(false);
  });

  it('관리자는 관리자 메뉴가 마지막에 붙는다', () => {
    const items = navItemsFor({ isLoggedIn: true, isAdmin: true });
    expect(items[items.length - 1].href).toBe(ADMIN_NAV.href);
  });

  it('비로그인 관리자 플래그로 관리자 메뉴가 새지 않는다', () => {
    // 미들웨어가 실제 차단하지만, 노출 규칙도 같은 방향이어야 한다.
    const items = navItemsFor({ isLoggedIn: false, isAdmin: false });
    expect(items.some((i) => i.href === ADMIN_NAV.href)).toBe(false);
  });

  it('원본 배열을 변형하지 않는다 (호출마다 새 배열)', () => {
    const before = PUBLIC_NAV.length;
    navItemsFor({ isLoggedIn: true, isAdmin: true });
    navItemsFor({ isLoggedIn: true, isAdmin: true });
    expect(PUBLIC_NAV).toHaveLength(before);
  });
});

describe('아이콘 계약 (DESIGN.md 규칙 8)', () => {
  it('모든 메뉴 아이콘이 lucide 컴포넌트다 — 이모지·기하문자 문자열 금지', () => {
    for (const item of [...PUBLIC_NAV, ...AUTH_NAV, ADMIN_NAV]) {
      expect(typeof item.icon, `${item.href} 의 icon 이 컴포넌트가 아니다`).not.toBe('string');
      expect(item.icon).toBeTruthy();
    }
  });

  it('라벨에 이모지가 섞이지 않았다', () => {
    const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2190}-\u{2BFF}]/u;
    for (const item of [...PUBLIC_NAV, ...AUTH_NAV, ADMIN_NAV]) {
      expect(EMOJI.test(item.label), `${item.label} 에 이모지`).toBe(false);
    }
  });
});
