/**
 * ErrorState — 에러 상태. DESIGN.md §4.14 / §6.
 * 원인 · 요청 ID · 복구 수단(재시도)을 함께 보여준다.
 */
export default function ErrorState({
  title = '불러오지 못했습니다',
  detail,
  requestId,
  onRetry,
}: {
  title?: string;
  detail?: string;
  requestId?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="banner" data-tone="danger" role="alert">
      <span>
        <b>{title}</b>
        {detail && (
          <>
            <br />
            {detail}
          </>
        )}
        {requestId && (
          <>
            <br />
            <span className="text-mono">{requestId}</span>
          </>
        )}
      </span>
      <div className="spacer" />
      {onRetry && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
          다시 시도
        </button>
      )}
    </div>
  );
}
