'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession, signOut } from 'next-auth/react';
import { Menu, X } from 'lucide-react';
import { navItemsFor } from '@/lib/nav';
import ThemeToggle from '@/components/ui/ThemeToggle';

export default function SiteHeader() {
  const pathname  = usePathname();
  const { data: session, status } = useSession();
  const [open, setOpen] = useState(false);

  const isAdmin    = session?.user?.role === 'admin';
  const isLoggedIn = status === 'authenticated';
  // 좌측 사이드바(ProjectsDashboard)와 동일 규칙으로 메뉴 통일.
  // 관리자 링크는 아래 전용 버튼으로 별도 렌더하므로 여기선 isAdmin:false 로 제외.
  const navLinks   = navItemsFor({ isLoggedIn, isAdmin: false });

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href);

  const closeDrawer = () => setOpen(false);

  // 드로어는 ESC 로 닫는다(§8) — AgentChat 의 세션 드로어와 같은 계약.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    // pt-safe: iPhone 홈화면추가(standalone)에서 상태바에 헤더가 가리는 문제 보정(§11.2).
    <header className="site-header pt-safe">
      <div className="container site-header-inner">
        <Link href="/" onClick={closeDrawer} className="site-brand">
          Thundo
        </Link>

        {/* 넓은 화면: 가로 내비를 그대로 보여준다. 좁은 화면에선 숨기고 드로어로 넘긴다(§11.2). */}
        <div className="only-wide" style={{ flex: 1, minWidth: 0, overflowX: 'auto' }}>
          <nav className="topnav" aria-label="주요 메뉴">
            {navLinks.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className="nav-item"
                aria-current={isActive(href) ? 'page' : undefined}
              >
                <Icon size={16} aria-hidden />
                {label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="spacer only-narrow" />

        <div className="row only-wide">
          {status === 'loading' ? null : isLoggedIn ? (
            <>
              {isAdmin && (
                <Link href="/admin" className="btn btn-secondary btn-sm">
                  관리자
                </Link>
              )}
              <button
                type="button"
                onClick={() => signOut({ callbackUrl: '/' })}
                className="btn btn-ghost btn-sm"
              >
                로그아웃
              </button>
            </>
          ) : (
            /* 전역 크롬은 primary 를 쓰지 않는다 — 화면당 하나뿐인 primary 는
               그 페이지의 주 액션 몫이다(DESIGN.md §4.4). */
            <Link href="/login" className="btn btn-secondary btn-sm">
              로그인
            </Link>
          )}
        </div>

        <ThemeToggle />

        <span className="nav-divider only-wide" />

        <button
          type="button"
          className="btn btn-icon only-narrow"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? '메뉴 닫기' : '메뉴 열기'}
          aria-expanded={open}
        >
          {open ? <X size={20} aria-hidden /> : <Menu size={20} aria-hidden />}
        </button>
      </div>

      {open && (
        <>
          <div className="drawer-backdrop" onClick={closeDrawer} />
          <aside className="drawer" role="dialog" aria-modal="true" aria-label="모바일 메뉴">
            <div className="drawer-head">
              <span className="site-brand">메뉴</span>
              <div className="spacer" />
              <button type="button" onClick={closeDrawer} className="btn btn-icon" aria-label="메뉴 닫기">
                <X size={20} aria-hidden />
              </button>
            </div>
            <div className="drawer-body stack">
              <div className="list">
                {navLinks.map(({ href, label, icon: Icon }) => (
                  <Link
                    key={href}
                    href={href}
                    onClick={closeDrawer}
                    className="nav-item"
                    aria-current={isActive(href) ? 'page' : undefined}
                  >
                    <Icon size={18} aria-hidden />
                    {label}
                  </Link>
                ))}
              </div>
              <hr className="hr" />
              {status === 'loading' ? null : isLoggedIn ? (
                <div className="stack-2">
                  {isAdmin && (
                    <Link href="/admin" onClick={closeDrawer} className="btn btn-secondary btn-block">
                      관리자 페이지
                    </Link>
                  )}
                  <button
                    type="button"
                    onClick={() => { closeDrawer(); signOut({ callbackUrl: '/' }); }}
                    className="btn btn-ghost btn-block"
                  >
                    로그아웃
                  </button>
                </div>
              ) : (
                <Link href="/login" onClick={closeDrawer} className="btn btn-secondary btn-block">
                  로그인
                </Link>
              )}
            </div>
          </aside>
        </>
      )}
    </header>
  );
}
