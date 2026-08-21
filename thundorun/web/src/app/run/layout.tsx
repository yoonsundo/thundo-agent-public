/**
 * `/run`(TH-BOX 이미지 편집기) 격리 레이아웃.
 *
 * 사이트 UI 개편에서 **이 화면만 현행 그대로 둔다**(사용자 결정 2026-08-19).
 * 편집기는 캔버스·포인터 조작이 얽혀 있어 전역 스타일이 바뀌면 조작감이 깨진다.
 *
 * 왜 새 파일인가:
 *   격리 표시를 `page.tsx` 나 편집기 컴포넌트에 직접 붙이면 **동결 대상 8파일을 고치게 된다**
 *   (page.tsx · BackgroundRemoval · ColorChange · ColorCorrection · EraserTool · LayerCanvas ·
 *    LayerList · SizeTool). 라우트 레이아웃을 새로 추가하면 그 8개를 한 줄도 안 건드리고
 *   하위 전체에 스코프를 씌울 수 있다.
 *
 * 왜 `display: contents` 인가 (globals.css `.run-scope`):
 *   편집기 최상위가 `height: 100dvh` + flex 열이라, 래퍼가 레이아웃에 참여하면 높이 사슬이 끊긴다.
 *   `display: contents` 는 박스를 만들지 않아 **레이아웃에 아무 영향을 주지 않으면서**
 *   CSS 변수 상속과 하위 선택자만 성립시킨다.
 */
export default function RunScopeLayout({ children }: { children: React.ReactNode }) {
  return <div className="run-scope">{children}</div>;
}
