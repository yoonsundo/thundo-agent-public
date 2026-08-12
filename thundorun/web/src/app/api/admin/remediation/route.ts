/**
 * /api/admin/remediation — Goose 자가 조치 승인 큐 (관리자 전용)
 *   GET  -> 목록(listRemediations)
 *   POST -> 결정 { id, decision: 'approve'|'reject', reason? } (pending 만 전이 가능)
 * admin role 이중 검증(미들웨어 + 핸들러). server/remediation.ts 가 service_role 로 DB 접근.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession }          from 'next-auth';
import { authOptions }               from '@/lib/auth';
import { listRemediations, decideRemediation } from '@/server/remediation';

export const dynamic = 'force-dynamic';

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
  return NextResponse.json(await listRemediations());
}

export async function POST(req: NextRequest) {
  const session = await adminSession();
  if (!session) return unauthorized();

  let body: { id?: string; decision?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: '잘못된 JSON 바디' }, { status: 400 });
  }
  if (!body.id || (body.decision !== 'approve' && body.decision !== 'reject')) {
    return NextResponse.json({ error: 'id 와 decision(approve|reject) 필수' }, { status: 400 });
  }

  const actor = session.user?.email || session.user?.name || 'admin';
  const result = await decideRemediation(
    body.id,
    body.decision === 'approve' ? 'approved' : 'rejected',
    actor,
    body.reason,
  );
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
