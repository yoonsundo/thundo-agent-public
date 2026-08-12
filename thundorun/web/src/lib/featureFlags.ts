/**
 * lib/featureFlags.ts — 화면 노출 토글 단일 출처.
 *
 * 기능·데이터·API 는 그대로 두고 "화면에 보일지"만 여기서 끈다.
 * 되돌릴 때는 값을 true 로 바꾸면 끝(코드 삭제·복원 불필요).
 */

/**
 * 공지사항 공개 노출(2026-07-30 사용자 요청으로 off).
 *
 * off 시 숨겨지는 것: 홈 상단 고정 공지 배너(NoticeBanner), 헤더·사이드바의 '공지사항' 탭,
 * 관리자 셸 사이드바의 '공지 관리' 메뉴(AdminShell).
 * off 여도 유지되는 것: /notices·/admin/notices 라우트(URL 직접 접근 가능), /api/admin/notices, DB 데이터.
 */
export const SHOW_NOTICES: boolean = false;
