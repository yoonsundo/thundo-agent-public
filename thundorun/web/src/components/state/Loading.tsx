/**
 * Loading — 인라인 스피너 + 라벨. DESIGN.md §4.14.
 */
export default function Loading({ label = '불러오는 중…' }: { label?: string }) {
  return (
    <div className="row" role="status" aria-live="polite">
      <span className="spinner" />
      <span className="text-muted">{label}</span>
    </div>
  );
}
