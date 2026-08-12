/**
 * (site)/loading.tsx — 공개 사이트 로딩 골격 (DESIGN.md §6 · §12.7).
 *
 * 완성 화면과 같은 골격(헤더 자리 + 카드 목록)을 유지해 데이터가 도착할 때
 * 레이아웃이 튀지 않게 한다 — 상태 3종 중 "로딩".
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
