/**
 * app/admin/page.tsx — 관리자 대시보드 서버 컴포넌트
 * (site) 라우트 그룹 밖 — SiteHeader/Footer 없음, 독립 레이아웃.
 * 미들웨어(middleware.ts)가 admin role 1차 차단.
 * 여기서 getServerSession 2차 검증 → role !== 'admin' 이면 /login 리다이렉트.
 */
import { getServerSession } from 'next-auth';
import { redirect }         from 'next/navigation';
import { authOptions }      from '@/lib/auth';
import AdminDashboard       from '@/components/AdminDashboard';

export const metadata = {
  title:  'CEO 대시보드',
  robots: 'noindex, nofollow',
};

export default async function AdminPage() {
  const session = await getServerSession(authOptions);

  // 2차 보안 검증 — 미들웨어 통과 후에도 server-side 재확인
  if (!session || session.user?.role !== 'admin') {
    redirect('/login?callbackUrl=/admin');
  }

  const adminId = session.user?.name ?? session.user?.email ?? '관리자';

  return <AdminDashboard adminId={adminId} />;
}
