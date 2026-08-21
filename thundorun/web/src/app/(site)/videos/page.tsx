import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { getActiveVideos } from '@/server/videos';
import VideoFacade from '@/components/VideoFacade';
import Empty from '@/components/state/Empty';
import { pageWindow } from '@/lib/pagination';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: '영상 — Thundo',
  description: '블로그 글과 반전 지식을 담은 유튜브 쇼츠 모음.',
};

/**
 * 한 페이지에 담을 영상 수.
 * 4열 그리드라 3의 배수보다 4의 배수가 마지막 줄을 채운다. 107편이 한 번에 로드되던 것을
 * 나눈다 — 썸네일 100장을 한 화면에 붙이면 모바일에서 스크롤도 로딩도 감당이 안 된다.
 */
const PER_PAGE = 24;

const hrefFor = (page: number) => (page > 1 ? `/videos?page=${page}` : '/videos');

export default async function VideosPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { page = '1' } = await searchParams;
  const videos = await getActiveVideos();

  const totalPages = Math.max(1, Math.ceil(videos.length / PER_PAGE));
  // 범위를 벗어난 page 는 가장 가까운 유효 페이지로 접는다(빈 화면 대신).
  const current = Math.min(Math.max(1, parseInt(page, 10) || 1), totalPages);
  const start = (current - 1) * PER_PAGE;
  const pageItems = videos.slice(start, start + PER_PAGE);

  return (
    <div className="container">
      <div className="page-head">
        <div>
          <h1 className="page-title">영상</h1>
          <p className="page-sub">
            유튜브 쇼츠 · 카드형 9:16
            {videos.length > 0 && ` · 전체 ${videos.length}편`}
          </p>
        </div>
      </div>

      {videos.length === 0 ? (
        <Empty title="아직 영상이 없습니다" body="준비 중인 영상이 곧 올라옵니다. 잠시 후 다시 확인해 주세요." />
      ) : (
        <>
          <ul className="grid-4" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {pageItems.map((v) => (
              <li key={v.youtube_id} className="stack-2">
                <VideoFacade
                  youtubeId={v.youtube_id}
                  title={v.title}
                  thumbnailUrl={v.thumbnail_url}
                />
                <h2 className="card-title">{v.title}</h2>
                {v.published_at && (
                  <time dateTime={v.published_at} className="card-meta">
                    {new Intl.DateTimeFormat('ko-KR', {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                    }).format(new Date(v.published_at))}
                  </time>
                )}
              </li>
            ))}
          </ul>

          {totalPages > 1 && (
            <nav className="pagination" aria-label="페이지 이동">
              {current > 1 ? (
                <Link href={hrefFor(current - 1)} className="page-btn" aria-label="이전 페이지">
                  <ChevronLeft size={16} aria-hidden="true" />
                </Link>
              ) : (
                <button type="button" className="page-btn" disabled aria-label="이전 페이지">
                  <ChevronLeft size={16} aria-hidden="true" />
                </button>
              )}

              {pageWindow(current, totalPages).map((n, i) =>
                n === null ? (
                  <span key={`gap-${i}`} className="page-btn" aria-hidden="true">…</span>
                ) : (
                  <Link
                    key={n}
                    href={hrefFor(n)}
                    aria-current={n === current ? 'page' : undefined}
                    className="page-btn"
                  >
                    {n}
                  </Link>
                ),
              )}

              {current < totalPages ? (
                <Link href={hrefFor(current + 1)} className="page-btn" aria-label="다음 페이지">
                  <ChevronRight size={16} aria-hidden="true" />
                </Link>
              ) : (
                <button type="button" className="page-btn" disabled aria-label="다음 페이지">
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              )}
            </nav>
          )}
        </>
      )}
    </div>
  );
}
