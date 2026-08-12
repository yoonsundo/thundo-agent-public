/**
 * app/admin/notices/[id]/edit/page.tsx — 공지 수정 (서버 컴포넌트)
 * 미들웨어 1차 차단 + getServerSession 2차 검증(role !== 'admin' -> /login).
 * 초기값은 getAllNotices()에서 찾아 전달 — 없으면 notFound().
 */
import { getServerSession }  from 'next-auth';
import { redirect }          from 'next/navigation';
import { notFound }          from 'next/navigation';
import { authOptions }       from '@/lib/auth';
import { getAllNotices }     from '@/server/notices';
import NoticeForm            from '@/components/NoticeForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: '공지 수정', robots: 'noindex, nofollow' };

export default async function AdminNoticeEditPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') {
    redirect('/login?callbackUrl=/admin/notices');
  }

  const { id } = await params;
  const notice = (await getAllNotices()).find((n) => n.id === id);
  if (!notice) notFound();

  return (
    <NoticeForm
      mode="edit"
      id={notice.id}
      initial={{ title: notice.title, body: notice.body, pinned: notice.pinned }}
    />
  );
}
