'use client';

/**
 * AdminShell — 어드민 공통 앱 셸. DESIGN.md §4.1 정본 마크업.
 *
 * `.shell` > `.sidebar` + `.shell-main`(`.topbar` + `.shell-body`) 구조를 어드민 전 라우트가 공유한다.
 * 활성 메뉴는 `aria-current="page"`(§8), 접기는 `.shell[data-collapsed]`.
 * 데이터는 다루지 않는다 — 표현 전용 셸이다.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { signOut } from 'next-auth/react';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowLeft, Bot, FolderKanban, GalleryVerticalEnd, LayoutDashboard, LogOut, Megaphone, Menu,
  MessageCircleQuestion, MessageSquare, ShieldCheck, SlidersHorizontal, Sparkles,
} from 'lucide-react';
import ThemeToggle from '@/components/ui/ThemeToggle';
import { SHOW_NOTICES } from '@/lib/featureFlags';

interface AdminNavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

/** 공지 관리 메뉴 — SHOW_NOTICES 가 true 일 때만 사이드바에 노출. 라우트(/admin/notices)는 그대로 살아 있다. */
const NOTICES_ITEM: AdminNavItem = { href: '/admin/notices', label: '공지 관리', icon: Megaphone };

const NAV_GROUPS: Array<{ title: string; items: AdminNavItem[] }> = [
  { title: '분석', items: [
    { href: '/admin', label: '대시보드', icon: LayoutDashboard },
  ] },
  { title: '콘텐츠', items: [
    ...(SHOW_NOTICES ? [NOTICES_ITEM] : []),
    { href: '/admin/projects',  label: '프로젝트 관리',       icon: FolderKanban },
    { href: '/admin/portfolio', label: '포트폴리오 미리보기', icon: GalleryVerticalEnd },
    { href: '/admin/portfolio-2', label: '포트폴리오 미리보기 2', icon: GalleryVerticalEnd },
    // 홈 메인에서 내린 방문자 Q&A — 화면은 이제 여기에만 있다(2026-08-07).
    { href: '/admin/site-guide', label: '방문자 Q&A', icon: MessageCircleQuestion },
  ] },
  { title: '에이전트·운영', items: [
    { href: '/admin/agents',       label: '에이전트 관리',       icon: Bot },
    { href: '/admin/chat',         label: '에이전트 채팅',       icon: MessageSquare },
    { href: '/admin/orchestrator', label: '오케스트레이션 콘솔', icon: SlidersHorizontal },
    { href: '/admin/remediation',  label: '자가 조치 승인',      icon: ShieldCheck },
  ] },
  { title: '기타', items: [
    { href: '/saju/amond', label: '아몬드 (사주 관제)', icon: Sparkles },
  ] },
];

/** 브레드크럼 라벨용 전체 목록 — 메뉴에서 숨긴 공지 관리도 URL 직접 접근 시 라벨은 나와야 하므로 항상 포함. */
const ALL_ITEMS = [...NAV_GROUPS.flatMap((g) => g.items), ...(SHOW_NOTICES ? [] : [NOTICES_ITEM])];

/** 활성 판정 — '/admin' 은 정확히 일치, 하위 라우트는 접두어(예: /admin/notices/new → 공지 관리). */
function isActive(href: string, pathname: string): boolean {
  if (href === '/admin') return pathname === '/admin';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** 현재 경로에 해당하는 메뉴 라벨(가장 구체적인 항목). */
function currentLabel(pathname: string): string {
  const hit = [...ALL_ITEMS]
    .sort((a, b) => b.href.length - a.href.length)
    .find((i) => isActive(i.href, pathname));
  return hit?.label ?? '관리자';
}

/** 아바타 이니셜 — 이름/이메일 앞 두 글자. */
function initials(id: string): string {
  const base = id.trim().replace(/@.*$/, '');
  return (base.slice(0, 2) || 'AD').toUpperCase();
}

export default function AdminShell({
  adminId,
  children,
}: {
  adminId: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? '/admin';
  const [collapsed, setCollapsed] = useState(false);
  // 모바일(≤700px) 드로어 — 데스크톱 collapsed(레일 축소)와 별개 상태.
  // 메뉴로 페이지를 이동하면 드로어가 열린 채 남지 않도록 경로 변경 시 닫는다.
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => { setMobileOpen(false); }, [pathname]);

  return (
    <div className="shell" data-collapsed={collapsed} data-mobile-open={mobileOpen}>
      {mobileOpen ? (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="메뉴 닫기"
          onClick={() => setMobileOpen(false)}
        />
      ) : null}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="sidebar-mark" />
          <span className="nav-label">THUNDO</span>
        </div>

        <nav aria-label="관리자 메뉴">
          {NAV_GROUPS.map((group) => (
            <div key={group.title}>
              <div className="sidebar-group kicker"><span className="nav-label">{group.title}</span></div>
              {group.items.map(({ href, label, icon: Icon }) => (
                <Link
                  key={href}
                  href={href}
                  className="nav-item"
                  aria-label={label}
                  title={collapsed ? label : undefined}
                  aria-current={isActive(href, pathname) ? 'page' : undefined}
                >
                  <Icon size={16} aria-hidden />
                  <span className="nav-label">{label}</span>
                </Link>
              ))}
            </div>
          ))}
        </nav>

        <div className="spacer" />

        <div className="sidebar-group kicker"><span className="nav-label">계정</span></div>
        <Link href="/" className="nav-item" aria-label="메인으로" title={collapsed ? '메인으로' : undefined}>
          <ArrowLeft size={16} aria-hidden />
          <span className="nav-label">메인으로</span>
        </Link>
        <button
          type="button"
          className="nav-item"
          aria-label="로그아웃"
          title={collapsed ? '로그아웃' : undefined}
          onClick={() => void signOut({ callbackUrl: '/login' })}
        >
          <LogOut size={16} aria-hidden />
          <span className="nav-label">로그아웃</span>
        </button>
      </aside>

      <div className="shell-main">
        <header className="topbar">
          {/* 넓은 화면: 레일 축소 토글 / 좁은 화면: 드로어 토글 — only-wide/only-narrow 로 분기(700px). */}
          <button
            type="button"
            className="btn btn-icon only-wide"
            aria-label={collapsed ? '사이드바 펼치기' : '사이드바 접기'}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((v) => !v)}
          >
            <Menu size={20} aria-hidden />
          </button>
          <button
            type="button"
            className="btn btn-icon only-narrow"
            aria-label={mobileOpen ? '메뉴 닫기' : '메뉴 열기'}
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen((v) => !v)}
          >
            <Menu size={20} aria-hidden />
          </button>
          <div className="crumb">
            <span>관리자</span>
            <span>/</span>
            <b>{currentLabel(pathname)}</b>
          </div>
          <div className="spacer" />
          <ThemeToggle />
          <div className="avatar" title={adminId}>{initials(adminId)}</div>
        </header>
        <div className="shell-body">{children}</div>
      </div>
    </div>
  );
}
