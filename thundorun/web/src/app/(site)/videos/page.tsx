import { getActiveVideos } from '@/server/videos';
import VideoFacade from '@/components/VideoFacade';
import Empty from '@/components/state/Empty';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: '영상 — Thundo',
  description: '블로그 글과 반전 지식을 담은 유튜브 쇼츠 모음.',
};

export default async function VideosPage() {
  const videos = await getActiveVideos();

  return (
    <div className="container">
      <div className="page-head">
        <div>
          <h1 className="page-title">영상</h1>
          <p className="page-sub">유튜브 쇼츠 · 카드형 9:16</p>
        </div>
      </div>

      {videos.length === 0 ? (
        <Empty title="아직 영상이 없습니다" body="준비 중인 영상이 곧 올라옵니다. 잠시 후 다시 확인해 주세요." />
      ) : (
        <ul className="grid-4" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {videos.map((v) => (
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
      )}
    </div>
  );
}
