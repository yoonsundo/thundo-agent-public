/**
 * lib/nav.ts — 사이트 네비게이션 단일 출처.
 *
 * 상단 헤더(SiteHeader)와 좌측 사이드바(ProjectsDashboard)가 이 설정을 공유해
 * 두 메뉴가 서로 어긋나지 않게 한다("통일"). 항목을 여기서 한 번만 바꾸면 양쪽에 반영된다.
 *
 * 권한 게이트(노출 규칙): 도구함(/home)은 로그인 필요, 관리자(/admin)는 role==='admin' 전용.
 * 실제 접근 제어는 미들웨어(src/middleware.ts)가 담당하고, 여기서는 노출 여부만 같은 규칙으로 맞춘다.
 */
import type { LucideIcon } from 'lucide-react';
import {
  Home, PenLine, Play, Images, Megaphone, Bot, ClipboardList, Wrench, UserCircle, Settings,
} from 'lucide-react';
import { SHOW_NOTICES } from '@/lib/featureFlags';

export interface NavItem {
  href: string;
  label: string;
  /** lucide-react 아이콘 컴포넌트. 이모지·기하문자 금지(DESIGN.md 규칙 8). */
  icon: LucideIcon;
}

/** 공지사항 탭 — SHOW_NOTICES(lib/featureFlags.ts) 가 true 일 때만 PUBLIC_NAV 에 들어간다. 라우트(/notices)는 그대로 살아 있다. */
const NOTICES_NAV: NavItem = { href: '/notices', label: '공지사항', icon: Megaphone };

/** 공개 메뉴 — 비로그인 포함 항상 노출. (프로젝트 탭은 2026-07-02 사용 중단 → 같은 대시보드를 '홈'으로 리브랜딩) */
export const PUBLIC_NAV: NavItem[] = [
  { href: '/',        label: '홈',       icon: Home },
  { href: '/blog',    label: '블로그',   icon: PenLine },
  { href: '/videos',  label: '영상',     icon: Play },
  { href: '/cardnews', label: '카드뉴스', icon: Images },
  ...(SHOW_NOTICES ? [NOTICES_NAV] : []),
];

/** 로그인 전용 메뉴 — authenticated 시에만 추가. (에이전트·일지는 2026-07-06 로그인 전용 전환) */
export const AUTH_NAV: NavItem[] = [
  { href: '/agents',  label: '에이전트', icon: Bot },
  { href: '/reports', label: '에이전트 일지', icon: ClipboardList },
  { href: '/home',    label: '도구함',   icon: Wrench },
  { href: '/account', label: '마이페이지', icon: UserCircle },
];

/** 관리자 전용 메뉴 — role==='admin' 시에만 추가. */
export const ADMIN_NAV: NavItem = { href: '/admin', label: '관리자', icon: Settings };

/** 로그인/권한 상태에 따른 메뉴 구성(단일 규칙 — 헤더·사이드바 공용). */
export function navItemsFor(opts: { isLoggedIn: boolean; isAdmin: boolean }): NavItem[] {
  const items = [...PUBLIC_NAV];
  if (opts.isLoggedIn) items.push(...AUTH_NAV);
  if (opts.isAdmin) items.push(ADMIN_NAV);
  return items;
}
