'use client';

/**
 * (site)/error.tsx — 공개 사이트 에러 경계 (DESIGN.md §6 · §12.7).
 *
 * 렌더 중 예외가 나면 Next 가 이 화면으로 대체한다. 원인 · 요청 ID(`error.digest`,
 * 운영 로그 추적용) · 복구 수단(`reset`)을 함께 보여준다 — 상태 3종 중 "에러".
 */
import ErrorState from '@/components/state/ErrorState';

export default function SiteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="container-narrow">
      <div className="page-head">
        <div>
          <h1 className="page-title">화면을 불러오지 못했습니다</h1>
          <p className="page-sub">일시적인 오류일 수 있습니다. 다시 시도해 주세요.</p>
        </div>
      </div>

      <ErrorState
        detail="요청을 처리하는 중 문제가 발생했습니다. 다시 시도해도 같은 화면이 나오면 잠시 후 접속해 주세요."
        requestId={error.digest}
        onRetry={reset}
      />
    </div>
  );
}
