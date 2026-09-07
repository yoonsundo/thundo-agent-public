'use client';

/**
 * AdminBlogViews — 글 상세의 조회수 칩. **관리자에게만** 보이고, 숫자는 서버 렌더가 아니라
 * 관리자 전용 엔드포인트에서 받아 온다.
 *
 * 🔴 왜 클라이언트인가: /blog/[slug] 는 ISR 이다. 캐시된 HTML 하나를 전 방문자가 공유하므로
 *    세션별로 다른 것을 그릴 수 없다 — 서버에서 조건부로 그리면 "먼저 온 사람의 화면"이
 *    캐시에 굳어 비관리자에게도 숫자가 나간다. 가리는 게 아니라 **보내지 않는** 구조여야 한다
 *    (홈 인기글이 같은 이유로 같은 모양이다 — ProjectsDashboard).
 *
 * 비관리자는 fetch 조차 하지 않는다(유출 차단 + 불필요한 왕복 제거).
 */
import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { Eye } from 'lucide-react';

export default function AdminBlogViews({ slug }: { slug: string }) {
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === 'admin';
  // null = 아직 모름(요청 전·실패). 0 과 구분한다 — "0회"와 "못 받아옴"은 다른 사실이다.
  const [views, setViews] = useState<number | null>(null);

  useEffect(() => {
    if (!isAdmin || !slug) return;
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(`/api/admin/blog-views?slug=${encodeURIComponent(slug)}`);
        if (!res.ok) return;
        const body = (await res.json()) as { views?: unknown };
        if (alive && typeof body.views === 'number') setViews(body.views);
      } catch {
        // 조회수는 부가 정보다 — 실패해도 글 화면을 방해하지 않는다.
      }
    })();
    return () => { alive = false; };
  }, [isAdmin, slug]);

  if (!isAdmin || views === null) return null;

  return (
    <>
      <span aria-hidden="true">·</span>
      <span className="row">
        <Eye size={14} aria-hidden="true" /> {views.toLocaleString()} 조회
      </span>
    </>
  );
}
