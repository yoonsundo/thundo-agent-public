/**
 * NoticeBanner.tsx — 홈 상단 고정 공지 배너 (서버 컴포넌트)
 * 최대 5건, pinned_at desc. 0건이면 렌더하지 않음.
 */
import Link from 'next/link';
import { Pin } from 'lucide-react';

export interface NoticeBannerItem {
  id:    string;
  title: string;
}

export default function NoticeBanner({ notices }: { notices: NoticeBannerItem[] }) {
  if (notices.length === 0) return null;

  return (
    <div className="container-narrow stack-2" style={{ paddingTop: 'var(--space-3)' }}>
      {notices.map((n) => (
        <Link key={n.id} href={`/notices/${n.id}`} className="card-link">
          <div className="banner" data-tone="warning">
            <Pin size={16} aria-hidden />
            <span>{n.title}</span>
          </div>
        </Link>
      ))}
    </div>
  );
}
