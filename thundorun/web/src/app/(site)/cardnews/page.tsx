import { ExternalLink } from 'lucide-react';
import { getActiveCardnews } from '@/server/cardnews';
import Empty from '@/components/state/Empty';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: '카드뉴스 — Thundo',
  description: '고전문학의 문장으로 건네는 위로. 인스타그램 카드뉴스 모음.',
};

export default async function CardnewsPage() {
  const posts = await getActiveCardnews();

  return (
    <div className="container">
      <div className="page-head">
        <div>
          <h1 className="page-title">카드뉴스</h1>
          <p className="page-sub">인스타그램 · 고전문학의 문장으로 건네는 위로</p>
        </div>
      </div>

      {posts.length === 0 ? (
        <Empty title="아직 카드뉴스가 없습니다" body="준비 중인 카드뉴스가 곧 올라옵니다. 잠시 후 다시 확인해 주세요." />
      ) : (
        <ul className="grid-4" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {posts.map((p) => {
            const headline = p.problem || p.subject;
            return (
              <li key={p.post_id} className="stack-2">
                {/* 콘텐츠 사진은 원색으로 둔다(§12.11). 슬라이드 원본은 1080×1350(4:5). */}
                <div className="card" style={{ padding: 0, overflow: 'hidden', aspectRatio: '4 / 5', width: '100%' }}>
                  {p.cover_url && (
                    <img
                      src={p.cover_url}
                      alt={headline}
                      loading="lazy"
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  )}
                </div>
                <h2 className="card-title">{headline}</h2>
                {p.book && (
                  <p className="card-meta">
                    {p.author ? `${p.book} · ${p.author}` : p.book}
                  </p>
                )}
                {p.published_at && (
                  <time dateTime={p.published_at} className="card-meta">
                    {new Intl.DateTimeFormat('ko-KR', {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                    }).format(new Date(p.published_at))}
                  </time>
                )}
                {/* 퍼머링크가 저장된 글만 원문으로 보낸다 — media_id 로 주소를 지어내지 않는다. */}
                {p.permalink && (
                  <a
                    href={p.permalink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="card-meta"
                  >
                    인스타그램에서 보기
                    <ExternalLink size={14} aria-hidden="true" />
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
