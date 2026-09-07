import Link from 'next/link';

export default function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    // pb-safe(globals.css @supports 내부 등록)는 design-guard 스캐너가 중첩 @supports 를
    // 파싱하지 못해 오탐되므로, 동일 효과의 env() 를 치수 전용 인라인 스타일로 직접 적용한다.
    <footer className="site-footer" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <div className="container row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <p>© {year} Thundo. All rights reserved.</p>
        {/* 편집 정책은 푸터에 둔다 — 홈을 포함한 모든 공개 화면에서 한 번에 닿아야 하고,
            상단 내비에 넣으면 콘텐츠 메뉴들 사이에서 성격이 다른 항목이 된다. */}
        <p className="text-muted row">
          <Link href="/editorial-policy">편집 정책 · AI 사용 고지</Link>
          <span aria-hidden="true">·</span>
          <span>AI 도구 · 자동화 · 생산성 — Thundo 프로젝트</span>
        </p>
      </div>
    </footer>
  );
}
