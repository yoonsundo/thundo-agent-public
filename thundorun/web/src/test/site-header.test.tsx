/**
 * site-header.test.tsx — 공개 사이트 헤더 계약.
 *
 * 헤더는 모든 화면에 나오므로 회귀가 가장 비싸다. 키트 클래스·접근성 계약과
 * 세션 상태별 분기를 고정해 둔다(§4.1·§8·§11.2).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as nextAuth from 'next-auth/react';
import * as nextNav from 'next/navigation';
import SiteHeader from '@/components/SiteHeader';
import { PUBLIC_NAV, AUTH_NAV, navItemsFor } from '@/lib/nav';

function mockSession(status: 'authenticated' | 'unauthenticated' | 'loading', role?: string) {
  vi.spyOn(nextAuth, 'useSession').mockReturnValue({
    data: status === 'authenticated' ? ({ user: { role } } as never) : null,
    status,
  } as never);
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(nextNav, 'usePathname').mockReturnValue('/blog');
});

describe('SiteHeader — 키트 구조', () => {
  it('.site-header + .container.site-header-inner + .topnav 골격을 쓴다', () => {
    mockSession('unauthenticated');
    const { container } = render(<SiteHeader />);
    expect(container.querySelector('header.site-header')).toBeTruthy();
    expect(container.querySelector('.site-header-inner')).toBeTruthy();
    expect(container.querySelector('.container')).toBeTruthy();
    expect(container.querySelector('nav.topnav')).toBeTruthy();
    expect(container.querySelector('.site-brand')).toBeTruthy();
  });

  it('iPhone standalone 안전영역 보정 클래스를 유지한다 (§11.2)', () => {
    mockSession('unauthenticated');
    const { container } = render(<SiteHeader />);
    expect(container.querySelector('header')?.classList.contains('pt-safe')).toBe(true);
  });

  it('내비 항목은 키트 .nav-item 이고 아이콘은 svg(lucide)다 — 이모지 금지', () => {
    mockSession('unauthenticated');
    const { container } = render(<SiteHeader />);
    const items = container.querySelectorAll('.topnav .nav-item');
    expect(items).toHaveLength(PUBLIC_NAV.length);
    items.forEach((el) => expect(el.querySelector('svg')).toBeTruthy());
    // 이모지·기하문자가 텍스트로 새지 않았는지
    expect(container.textContent ?? '').not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2190}-\u{2BFF}]/u);
  });
});

describe('SiteHeader — 접근성 (§8)', () => {
  it('활성 메뉴만 aria-current="page" 를 갖는다', () => {
    mockSession('unauthenticated');
    const { container } = render(<SiteHeader />);
    const current = container.querySelectorAll('.topnav [aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0].getAttribute('href')).toBe('/blog');
  });

  it('활성 표시를 클래스가 아니라 aria 속성으로 한다', () => {
    mockSession('unauthenticated');
    const { container } = render(<SiteHeader />);
    const active = container.querySelector('.topnav [aria-current="page"]')!;
    // .nav-item 하나만 있으면 됨 — 활성 전용 클래스를 덧붙이지 않는다
    expect(active.className.trim()).toBe('nav-item');
  });

  it('아이콘 전용 버튼에 aria-label 과 aria-expanded 가 있다', () => {
    mockSession('unauthenticated');
    render(<SiteHeader />);
    const menu = screen.getByRole('button', { name: '메뉴 열기' });
    expect(menu.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('SiteHeader — 세션 분기', () => {
  it('비로그인은 로그인 링크를 노출한다', () => {
    mockSession('unauthenticated');
    render(<SiteHeader />);
    expect(screen.getByRole('link', { name: '로그인' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '로그아웃' })).toBeNull();
  });

  it('전역 크롬은 .btn-primary 를 쓰지 않는다 (화면당 하나뿐인 primary 는 페이지 몫 — §4.4)', () => {
    mockSession('unauthenticated');
    const { container } = render(<SiteHeader />);
    expect(container.querySelectorAll('.btn-primary')).toHaveLength(0);
    expect(screen.getByRole('link', { name: '로그인' }).className).toContain('btn-secondary');
  });

  it('로그인 사용자는 로그아웃 + 로그인 전용 메뉴를 본다', () => {
    mockSession('authenticated', 'user');
    const { container } = render(<SiteHeader />);
    expect(screen.getByRole('button', { name: '로그아웃' })).toBeTruthy();
    expect(container.querySelectorAll('.topnav .nav-item')).toHaveLength(
      navItemsFor({ isLoggedIn: true, isAdmin: false }).length,
    );
    expect(AUTH_NAV.length).toBeGreaterThan(0);
  });

  it('관리자만 관리자 링크를 본다', () => {
    mockSession('authenticated', 'admin');
    render(<SiteHeader />);
    expect(screen.getByRole('link', { name: '관리자' })).toBeTruthy();
  });

  it('세션 로딩 중에는 인증 액션을 렌더하지 않는다 (깜빡임 방지)', () => {
    mockSession('loading');
    render(<SiteHeader />);
    expect(screen.queryByRole('link', { name: '로그인' })).toBeNull();
    expect(screen.queryByRole('button', { name: '로그아웃' })).toBeNull();
  });
});

describe('SiteHeader — 모바일 드로어 (§4.13)', () => {
  it('토글하면 .drawer 가 열리고 닫기 버튼으로 사라진다', async () => {
    mockSession('unauthenticated');
    const { container } = render(<SiteHeader />);
    expect(container.querySelector('.drawer')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: '메뉴 열기' }));
    expect(container.querySelector('.drawer')).toBeTruthy();
    expect(container.querySelector('.drawer-backdrop')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '메뉴 닫기' }).length).toBeGreaterThan(0);

    await userEvent.click(screen.getAllByRole('button', { name: '메뉴 닫기' })[0]);
    expect(container.querySelector('.drawer')).toBeNull();
  });

  it('드로어 배경을 누르면 닫힌다', async () => {
    mockSession('unauthenticated');
    const { container } = render(<SiteHeader />);
    await userEvent.click(screen.getByRole('button', { name: '메뉴 열기' }));
    await userEvent.click(container.querySelector('.drawer-backdrop')!);
    expect(container.querySelector('.drawer')).toBeNull();
  });
});
