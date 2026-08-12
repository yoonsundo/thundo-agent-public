'use client';

// 공유 버튼 — 링크 복사(clipboard) + X(트위터) 공유. 상세 페이지 하단에 배치.
// 서버 렌더된 상세 페이지에서 이 조각만 클라이언트로 분리해 상호작용을 최소화한다.
import { useState } from 'react';
import { Link2, Share2 } from 'lucide-react';

interface ShareButtonsProps {
  url: string;    // 절대 URL (예: https://www.thundo.kr/blog/<slug>)
  title: string;
}

export default function ShareButtons({ url, title }: ShareButtonsProps) {
  const [copied, setCopied] = useState(false);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // clipboard 권한 거부/비보안 컨텍스트 — 조용히 무시(버튼은 실패 표시 없이 그대로).
    }
  }

  const tweetHref =
    `https://twitter.com/intent/tweet?text=${encodeURIComponent(title)}&url=${encodeURIComponent(url)}`;

  return (
    <div className="row" data-noprint>
      <button type="button" onClick={copyLink} className="btn btn-secondary btn-sm">
        <Link2 size={16} aria-hidden="true" />
        <span>{copied ? '복사됨' : '링크 복사'}</span>
      </button>

      <a
        href={tweetHref}
        target="_blank"
        rel="noopener noreferrer"
        className="btn btn-secondary btn-sm"
        aria-label="X(트위터)로 공유"
      >
        <Share2 size={16} aria-hidden="true" />
        <span>X 공유</span>
      </a>
    </div>
  );
}
