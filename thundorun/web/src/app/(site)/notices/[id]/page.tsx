import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Pin } from 'lucide-react';
import { getAllNotices } from '@/server/notices';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const notice = (await getAllNotices()).find((n) => n.id === id);
  if (!notice) return {};
  return {
    title: `${notice.title} — Thundo`,
    description: notice.title,
  };
}

export default async function NoticeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const notice = (await getAllNotices()).find((n) => n.id === id);
  if (!notice) notFound();

  const formattedDate = new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(notice.created_at));

  return (
    <article className="container-narrow">
      <div className="page-head">
        <div className="stack-2">
          {notice.pinned && (
            <span className="tag tag-warning" aria-label="고정됨" style={{ alignSelf: 'flex-start' }}>
              <Pin size={14} aria-hidden="true" /> 고정
            </span>
          )}
          <h1 className="page-title">{notice.title}</h1>
          <p className="page-sub">
            <time dateTime={notice.created_at}>{formattedDate}</time>
          </p>
        </div>
      </div>

      <div className="article">
        <p style={{ whiteSpace: 'pre-wrap' }}>{notice.body}</p>
      </div>

      <hr className="hr" style={{ marginTop: 'var(--space-8)' }} />
      <Link href="/notices" className="btn btn-ghost">
        <ArrowLeft size={16} aria-hidden="true" /> 공지 목록으로
      </Link>
    </article>
  );
}
