/**
 * app/admin/notices/new/page.tsx — 공지 작성 (서버 컴포넌트)
 * 미들웨어 1차 차단 + getServerSession 2차 검증(role !== 'admin' -> /login).
 */
import { getServerSession }  from 'next-auth';
import { redirect }          from 'next/navigation';
import { authOptions }       from '@/lib/auth';
import NoticeForm            from '@/components/NoticeForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: '새 공지', robots: 'noindex, nofollow' };

export default async function AdminNoticeNewPage() {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') {
    redirect('/login?callbackUrl=/admin/notices/new');
  }
  return <NoticeForm mode="create" />;
}
