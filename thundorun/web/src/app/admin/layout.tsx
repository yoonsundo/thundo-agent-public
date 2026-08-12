/**
 * app/admin/layout.tsx — 어드민 공통 셸 레이아웃 (서버 컴포넌트)
 *
 * (site) 라우트 그룹 밖이라 SiteHeader/Footer 가 없다 → 어드민은 DESIGN.md §4.1 앱 셸을 쓴다.
 * 접근 제어는 그대로 middleware.ts(1차) + 각 page.tsx 의 getServerSession(2차)가 담당한다.
 * 여기서는 아바타·표시용 식별자만 읽는다(리다이렉트 없음 — 판정은 페이지 몫).
 */
import { getServerSession } from 'next-auth';
import { authOptions }      from '@/lib/auth';
import AdminShell           from './AdminShell';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  const adminId = session?.user?.name ?? session?.user?.email ?? '관리자';

  return <AdminShell adminId={adminId}>{children}</AdminShell>;
}
