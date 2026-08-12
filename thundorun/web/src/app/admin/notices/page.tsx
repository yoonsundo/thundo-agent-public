/**
 * app/admin/notices/page.tsx — 공지 관리 목록 (서버 컴포넌트)
 * 미들웨어 1차 차단 + getServerSession 2차 검증(role !== 'admin' -> /login).
 */
import { getServerSession }  from 'next-auth';
import { redirect }          from 'next/navigation';
import { authOptions }       from '@/lib/auth';
import NoticesAdminList      from '@/components/NoticesAdminList';

export const dynamic = 'force-dynamic';
export const metadata = { title: '공지 관리', robots: 'noindex, nofollow' };

export default async function AdminNoticesPage() {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') {
    redirect('/login?callbackUrl=/admin/notices');
  }
  return <NoticesAdminList />;
}
