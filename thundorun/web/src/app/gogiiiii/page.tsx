import QuizBoard from '@/components/QuizBoard';

/**
 * /gogiiiii — KBO 상식 퀴즈.
 *
 * 🔴 **어느 메뉴에도 걸지 않는다.** URL 을 아는 사람만 들어온다(사용자 요구).
 *    lib/nav.ts 에 추가 금지. sitemap 제외. noindex.
 *
 * ⚠ `(site)` 그룹 **밖**에 두는 이유: 그 그룹 레이아웃이 사이트 헤더(홈·블로그·관리자·로그아웃…)를
 *    붙인다. 회사에서 몰래 여는 화면에 그 메뉴줄이 떠 있으면 위장이 통째로 무의미하다.
 *    여기 두면 루트 레이아웃만 적용돼 화면에 퀴즈만 남는다.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: '분기 운영 점검',
  description: '내부 검토용 문서',
  robots: 'noindex, nofollow',
};

export default function QuizPage() {
  return <QuizBoard />;
}
