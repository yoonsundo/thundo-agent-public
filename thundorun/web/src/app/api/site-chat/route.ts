import { NextRequest, NextResponse, after } from 'next/server';
import { getProfile } from '@/server/siteProfile';
import { getProjects } from '@/server/projects';
import { getPostSummaries } from '@/lib/blog';
import { getPopularPosts } from '@/server/popularPosts';
import { answerSiteQuestion } from '@/server/siteGuide';
import { recordMiss } from '@/server/sitechatMisses';
import { isAdminViewer } from '@/server/adminViewer';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: { message?: string };
  try {
    body = await req.json() as { message?: string };
  } catch {
    return NextResponse.json({ error: '잘못된 JSON 바디' }, { status: 400 });
  }

  const message = String(body.message || '').trim();
  if (!message) {
    return NextResponse.json({ error: 'message 필드가 비어 있습니다.' }, { status: 400 });
  }
  if (message.length > 500) {
    return NextResponse.json({ error: '질문은 500자 이하로 보내주세요.' }, { status: 400 });
  }

  // getPostSummaries: content 제외 경량 조회 — 여기선 postCount 와 인기글 제목만 쓰므로
  // 발행글 전체 HTML 본문을 매 요청마다 끌어올 이유가 없다.
  const [profile, projects, posts] = await Promise.all([
    getProfile(),
    getProjects(),
    getPostSummaries(),
  ]);
  const popularPosts = await getPopularPosts(posts, 5);
  // 조회수는 관리자에게만 — 챗봇 답변도 같은 경계를 지킨다(화면만 막고 여기로 새면 소용없다).
  const canSeeViews = await isAdminViewer();
  const reply = answerSiteQuestion(message, {
    profile,
    projects,
    popularPosts,
    postCount: posts.length,
    canSeeViews,
  });

  // 폴백으로 끝난 질문만 수집 (Stage B 착수 판단용) — 실패해도 응답은 정상 반환.
  // after(): 응답 반환 후 실행을 보장 — 서버리스는 응답 직후 함수를 freeze 하므로
  // `void recordMiss()` 로는 쓰기가 유실된다 (middleware.ts 의 event.waitUntil 과 동일 클래스).
  if (reply.kind === 'fallback') after(() => recordMiss(message));

  return NextResponse.json({ ok: true, ...reply });
}
