/**
 * GET  /api/admin/orchestrator — 상황판(listBoard): status 별 카드 그리드
 * POST /api/admin/orchestrator { title, content } — 신규요청(제목*+내용) → 요청 카드 생성('requested')
 *   + orchestrate job enqueue. title 은 사용자 입력 그대로 저장(AI 는 plan.summary 만 덧붙임).
 * admin role 이중 검증(미들웨어 + 핸들러).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession }          from 'next-auth';
import { authOptions }               from '@/lib/auth';
import { createRequest, listBoard }  from '@/server/orchestration';

export const runtime  = 'nodejs';
export const dynamic  = 'force-dynamic';

function unauthorized() {
  return NextResponse.json({ error: '인증 필요' }, { status: 401 });
}

async function adminSession() {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') return null;
  return session;
}

export async function GET() {
  if (!(await adminSession())) return unauthorized();
  const board = await listBoard();
  return NextResponse.json({ board });
}

export async function POST(req: NextRequest) {
  const session = await adminSession();
  if (!session) return unauthorized();

  let body: { title?: string; content?: string };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: '잘못된 JSON 바디' }, { status: 400 });
  }

  const title = body.title?.trim();
  const content = body.content?.trim();
  if (!title) {
    return NextResponse.json({ error: 'title 필드 필수' }, { status: 400 });
  }
  if (!content) {
    return NextResponse.json({ error: 'content 필드 필수' }, { status: 400 });
  }

  const createdBy = session.user?.email ?? session.user?.name ?? 'admin';
  const result = await createRequest({ title, content, createdBy });
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
