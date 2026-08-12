'use client';

/**
 * VideoFacade — 유튜브 지연로드 파사드(성능 핵심).
 *
 * 초기엔 iframe 을 절대 로드하지 않고 썸네일 이미지 + 재생버튼 오버레이만 그린다.
 * 사용자가 클릭한 뒤에야 그 자리에 youtube-nocookie 임베드 iframe(autoplay)을 얹는다.
 * → 목록에 영상이 아무리 많아도 클릭 전엔 iframe 0개라 페이지가 가볍다.
 */
import { useState } from 'react';
import { Play } from 'lucide-react';

export default function VideoFacade({
  youtubeId,
  title,
  thumbnailUrl,
}: {
  youtubeId: string;
  title: string;
  thumbnailUrl?: string | null;
}) {
  const [playing, setPlaying] = useState(false);

  const poster =
    thumbnailUrl || `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`;

  return (
    // 콘텐츠 사진은 원색으로 둔다(§12.11) — 여기에 grayscale 을 걸면 포스터뿐 아니라
    // 재생 중인 iframe 과 재생 배지의 강조색까지 함께 탈색된다.
    <div
      className="card"
      style={{ position: 'relative', padding: 0, overflow: 'hidden', aspectRatio: '9 / 16', width: '100%' }}
    >
      {playing ? (
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${youtubeId}?autoplay=1`}
          title={title}
          allow="autoplay; encrypted-media"
          allowFullScreen
          loading="lazy"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setPlaying(true)}
          aria-label={`${title} 재생`}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', padding: 0, border: 0, background: 'none', cursor: 'pointer' }}
        >
          <img
            src={poster}
            alt={title}
            loading="lazy"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
          />
          <span
            aria-hidden="true"
            className="play-badge"
            style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}
          >
            <Play size={20} fill="currentColor" aria-hidden="true" />
          </span>
        </button>
      )}
    </div>
  );
}
