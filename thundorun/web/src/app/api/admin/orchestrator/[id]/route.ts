/**
 * GET /api/admin/orchestrator/[id] — 요청 카드 상세: 카드 + 서브태스크 + 대화(오케+실행 로그)
 * admin role 이중 검증(미들웨어 + 핸들러).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession }          from 'next-auth';
import { authOptions }               from '@/lib/auth';
import { getRequestDetail }          from '@/server/orchestration';

export const runtime  = 'nodejs';
export const dynamic  = 'force-dynamic';

function unauthorized() {
  return NextResponse.json({ error: '인증 필요' }, { status: 401 });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') return unauthorized();

  const { id } = await params;
  const detail = await getRequestDetail(id);
  if (!detail) return NextResponse.json({ error: '요청을 찾을 수 없음' }, { status: 404 });

  return NextResponse.json(detail);
}
