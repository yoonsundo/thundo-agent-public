/**
 * /api/admin/blog-views — 글 한 편의 누적 조회수 (admin 전용)
 *
 * 글 상세(/blog/[slug])는 ISR 이라 조회수를 서버 페이로드에 실을 수 없다 — 캐시된 HTML 을
 * 전 방문자가 공유하므로 숫자를 담는 순간 소스 보기 한 번에 새어 나간다. 그래서 홈과 같은
 * 모양으로 나눈다: 서버는 숫자를 **보내지 않고**, 관리자만 이 엔드포인트로 따로 받는다.
 *
 * 🔴 여기는 `/api/admin/popular-views` 와 달리 **전기간 누적**(getBlogViewMap)이 맞다.
 *    글 화면 옆에 붙는 숫자는 그 글이 지금까지 받은 총 조회수이고, 관리자 표(/admin 블로그
 *    관리)가 보여 주는 숫자와 같아야 한다. 90일 창을 쓰면 두 화면이 다른 수를 말한다.
 *
 * 인증: 미들웨어(`/api/admin/**`) + 이 핸들러 이중.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getBlogViews } from '@/server/blogViews';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') {
    return NextResponse.json({ error: '인증 필요' }, { status: 401 });
  }

  const slug = new URL(req.url).searchParams.get('slug')?.trim() ?? '';
  if (!slug) return NextResponse.json({ error: 'slug 필수' }, { status: 400 });

  // 조회 실패는 0 이 아니라 그대로 0 을 반환한다 — getBlogViews 가 이미 폴백을 정의한다.
  return NextResponse.json({ slug, views: await getBlogViews(slug) });
}
