import Link from 'next/link';
import { Pin } from 'lucide-react';
import { getAllNotices } from '@/server/notices';
import Empty from '@/components/state/Empty';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: '공지사항 — Thundo',
  description: 'Thundo 공지사항 모음.',
};

export default async function NoticesListPage() {
  const notices = await getAllNotices();

  return (
    <div className="container-narrow">
      <div className="page-head">
        <div>
          <h1 className="page-title">공지사항</h1>
        </div>
      </div>

      {notices.length === 0 ? (
        <Empty title="등록된 공지가 없습니다" />
      ) : (
        <div className="stack">
          {notices.map((n) => (
            <Link key={n.id} href={`/notices/${n.id}`} className="card card-link">
              {n.pinned && (
                <span className="tag tag-warning" aria-label="고정됨" style={{ alignSelf: 'flex-start' }}>
                  <Pin size={14} aria-hidden="true" /> 고정
                </span>
              )}
              <span className="card-title">{n.title}</span>
              <time className="card-meta" dateTime={n.created_at}>
                {new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' }).format(
                  new Date(n.created_at),
                )}
              </time>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
