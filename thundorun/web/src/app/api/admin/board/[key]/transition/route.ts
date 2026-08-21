/**
 * POST /api/admin/board/[key]/transition { action, comment? }
 *   action: 'approve' | 'reject' | 'hold'  ·  거부·보류는 comment 필수
 * admin role 이중 검증(미들웨어 + 핸들러) — orchestrator 전이 라우트와 같은 규약.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { transitionApproval, type TransitionAction } from '@/server/board-approvals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID: TransitionAction[] = ['approve', 'reject', 'hold'];

export async function POST(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') {
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });
  }
  const { key } = await params;

  let body: { action?: string; comment?: string };
  try { body = await req.json() as typeof body; }
  catch { return NextResponse.json({ ok: false, error: '잘못된 요청입니다' }, { status: 400 }); }

  if (!body.action || !VALID.includes(body.action as TransitionAction)) {
    return NextResponse.json({ ok: false, error: `action 은 ${VALID.join('|')} 중 하나여야 함` }, { status: 400 });
  }

  const result = await transitionApproval(decodeURIComponent(key), body.action as TransitionAction, {
    comment: body.comment,
    by: session.user?.email ?? undefined,
  });
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
