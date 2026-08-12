/**
 * /api/admin/popular-views — 홈 인기글의 조회수 숫자 (admin 전용)
 *
 * 홈은 ISR(revalidate=300)이라 조회수를 페이로드에 실을 수 없다(캐시를 전 방문자가 공유).
 * 그래서 서버는 순위만 넘기고, 관리자만 이 엔드포인트로 숫자를 따로 받아 채운다.
 *
 * 🔴 반드시 `fetchPopularSlugViews()` 를 써야 한다 — 홈의 **순위를 만든 것과 같은 함수**다.
 *    `/api/admin/blog` 의 `getBlogViewMap()` 은 날짜 필터가 없는 전기간 누적이라, 90일 창으로
 *    정렬된 순위 옆에 붙이면 "Top 5" 인데 숫자가 뒤죽박죽인 화면이 된다(리뷰 지적, 2026-08-07).
 *
 * 인증: 미들웨어(`/api/admin/**`) + 이 핸들러 이중.
 */
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { fetchPopularSlugViews } from '@/server/popularPosts';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') {
    return NextResponse.json({ error: '인증 필요' }, { status: 401 });
  }
  // [slug, views][] → { slug: views }. 홈에서 5개만 쓰지만 맵으로 주는 편이 호출측이 단순하다.
  return NextResponse.json(Object.fromEntries(await fetchPopularSlugViews()));
}
