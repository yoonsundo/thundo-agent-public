// RelatedPosts — 상세 페이지 하단 "관련 글" 3편. 서버 컴포넌트(상호작용 없음).
// 카드 스타일은 목록 페이지(blog/page.tsx)와 통일(.card + .card-link).
import Link from 'next/link';
import type { PostSummary } from '@/lib/blog';

function formatKo(date: string): string {
  return date
    ? new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(date))
    : '';
}

export default function RelatedPosts({ posts }: { posts: PostSummary[] }) {
  if (posts.length === 0) return null;

  return (
    <section className="stack-6" data-noprint aria-label="관련 글">
      <div className="section-head">
        <h2>관련 글</h2>
      </div>
      <div className="grid-3">
        {posts.map((p) => (
          <Link key={p.slug} href={`/blog/${p.slug}`} className="card card-link">
            {p.tags && p.tags.length > 0 && (
              <span className="card-kicker">{p.tags.slice(0, 2).map((t) => `#${t}`).join(' ')}</span>
            )}
            <span className="card-title">{p.title}</span>
            <time dateTime={p.date} className="card-meta">{formatKo(p.date)}</time>
          </Link>
        ))}
      </div>
    </section>
  );
}
