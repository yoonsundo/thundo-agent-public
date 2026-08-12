/**
 * Skeleton — 로딩 상태. DESIGN.md §4.14.
 * 완성 화면과 같은 골격을 유지한다(레이아웃 점프 금지).
 */
export function SkeletonLine({ width }: { width?: number | string }) {
  return <span className="skeleton skeleton-line" style={{ width, display: 'block' }} />;
}

export function SkeletonTitle() {
  return <span className="skeleton skeleton-title" style={{ display: 'block' }} />;
}

/** 표 로딩 — 열 수만 맞추면 헤더 아래 골격이 유지된다. */
export function TableSkeleton({ cols, rows = 5 }: { cols: number; rows?: number }) {
  return (
    <tbody>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r}>
          {Array.from({ length: cols }, (_, c) => (
            <td key={c}>
              <SkeletonLine width={c === 0 ? 88 : '70%'} />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}

/** 카드 목록 로딩. */
export function CardSkeleton({ count = 3 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div className="card stack-2" key={i}>
          <SkeletonTitle />
          <SkeletonLine width="90%" />
          <SkeletonLine width="60%" />
        </div>
      ))}
    </>
  );
}
