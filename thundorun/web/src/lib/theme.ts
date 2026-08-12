/**
 * theme.ts — 초기 테마 복원 스크립트.
 *
 * 저장된 선택(localStorage.theme)이 있으면 페인트 전에 `data-theme` 를 맞춰
 * 다크 사용자가 라이트 화면을 한 프레임 보는 깜빡임(FOUC)을 없앤다.
 * 저장값이 없으면 키트 정본 기본값인 light 를 그대로 둔다(OS 다크 추종 안 함 —
 * 사용자가 명시적으로 고른 값만 존중).
 */
export const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem('theme');if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;
