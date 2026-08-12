/**
 * POST /api/admin/orchestrator/[id]/transition { action, reject_reason?, replan_note?, hold_reason? }
 *   action: 'approve' | 'hold' | 'reject' | 'replan' | 'complete' | 'resume'
 *   승인→서브태스크 실행 enqueue, 보류→hold_reason 필수(요청중 전용), 반려→reject_reason 필수,
 *   재기획→replan_note 필수, 완료→완료대기 전용, 재기획완료(resume)→재기획 전용(요청중 복귀).
 *   ⚠ 진행 중(활성 job pending|running, 또는 서브태스크 queued|running)이면 서버가 모든 전환을
 *     거부한다 — 분해·재분해·실행·배포 어느 단계든 진행 중 상태변경 잠금.
 * admin role 이중 검증(미들웨어 + 핸들러). 불법 전이는 400 + {ok:false, error}.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession }          from 'next-auth';
import { authOptions }               from '@/lib/auth';
import { transition, type TransitionAction } from '@/server/orchestration';

export const runtime  = 'nodejs';
export const dynamic  = 'force-dynamic';

function unauthorized() {
  return NextResponse.json({ error: '인증 필요' }, { status: 401 });
}

const VALID_ACTIONS: TransitionAction[] = ['approve', 'hold', 'reject', 'replan', 'complete', 'resume'];

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') return unauthorized();

  const { id } = await params;

  let body: { action?: string; reject_reason?: string; replan_note?: string; hold_reason?: string };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: '잘못된 JSON 바디' }, { status: 400 });
  }

  if (!body.action || !VALID_ACTIONS.includes(body.action as TransitionAction)) {
    return NextResponse.json(
      { error: `action 은 ${VALID_ACTIONS.join('|')} 중 하나여야 함` },
      { status: 400 },
    );
  }

  const decidedBy = session.user?.email ?? session.user?.name ?? 'admin';
  const result = await transition(id, body.action as TransitionAction, {
    reject_reason: body.reject_reason,
    replan_note:   body.replan_note,
    hold_reason:   body.hold_reason,
    decided_by:    decidedBy,
  });

  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
