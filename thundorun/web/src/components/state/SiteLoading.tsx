/**
 * SiteLoading — 공개 사이트 로딩 골격 (DESIGN.md §6 · §12.7).
 *
 * 완성 화면과 같은 골격(헤더 자리 + 카드 목록)을 유지해 데이터가 도착할 때
 * 레이아웃이 튀지 않게 한다 — 상태 3종 중 "로딩".
 *
 * 🔴 예전엔 이 화면이 `(site)/loading.tsx` 였다. 그러면 (site) **그룹 전체**에 Suspense
 *    경계가 생겨 응답 헤더가 페이지 렌더보다 먼저 나간다. 그 뒤에 `notFound()` 가 던져져도
 *    상태줄은 이미 `200 OK` 라서, 없는 글이 "본문은 404 화면인데 HTTP 200" 인 soft-404 가 됐다
 *    (2026-09-07 라이브·로컬 양쪽 실측 — `(site)/loading.tsx` 를 지우자 404 로 돌아왔다).
 *    그래서 로딩 골격은 **notFound() 를 부르는 라우트의 조상이 아닌 세그먼트에만** 둔다.
 *    ⚠ 새 loading.tsx 를 만들 때는 그 아래 어딘가에 notFound() 가 있는지 먼저 본다
 *      (src/test/soft-404-status.test.ts 가 자동으로 잡는다).
 */
import { CardSkeleton, SkeletonLine, SkeletonTitle } from '@/components/state/Skeleton';

export default function SiteLoading() {
  return (
    <div className="container" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">불러오는 중…</span>

      {/* 페이지 헤더 자리 */}
      <div className="page-head">
        <div className="stack-2" style={{ width: '100%', maxWidth: 320 }}>
          <SkeletonTitle />
          <SkeletonLine width="60%" />
        </div>
      </div>

      <div className="stack-6">
        <CardSkeleton count={3} />
      </div>
    </div>
  );
}
