export default function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    // pb-safe(globals.css @supports 내부 등록)는 design-guard 스캐너가 중첩 @supports 를
    // 파싱하지 못해 오탐되므로, 동일 효과의 env() 를 치수 전용 인라인 스타일로 직접 적용한다.
    <footer className="site-footer" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <div className="container row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <p>© {year} Thundo. All rights reserved.</p>
        <p className="text-muted">AI 도구 · 자동화 · 생산성 — Thundo 프로젝트</p>
      </div>
    </footer>
  );
}
