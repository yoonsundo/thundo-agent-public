/**
 * POST /api/admin/command — CEO 명령 실행
 *
 * 보안 계약 (변형 금지):
 *   - admin role 이중 검증 (미들웨어 + 핸들러)
 *   - SAFE_COMMANDS 재검증 (executeCommand 내부에서도 검증)
 *   - 화이트리스트 외 type → 즉시 거부, 부수효과 없음
 *
 * Body: { type: string; args?: Record<string, unknown> }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession }          from 'next-auth';
import { authOptions }               from '@/lib/auth';
import { executeCommand, SAFE_COMMANDS } from '@/server/hub/commands';

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') {
    return NextResponse.json({ error: '인증 필요' }, { status: 401 });
  }

  let body: { type?: string; args?: Record<string, unknown> };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: '잘못된 JSON 바디' }, { status: 400 });
  }

  const { type, args = {} } = body;
  if (!type) {
    return NextResponse.json({ error: 'type 필드 필수' }, { status: 400 });
  }

  // 핸들러 레벨 SAFE_COMMANDS 재검증 (executeCommand 화이트리스트에 위임)
  if (!Object.prototype.hasOwnProperty.call(SAFE_COMMANDS, type)) {
    return NextResponse.json({ error: '허용되지 않은 명령', type }, { status: 403 });
  }

  const actor = session.user?.name ?? session.user?.email ?? 'admin';

  try {
    const result = await executeCommand({ type, args, actor });
    const status = result.ok ? 200 : result.rejected ? 403 : 500;
    return NextResponse.json(result, { status });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
