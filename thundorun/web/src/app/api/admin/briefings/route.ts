/**
 * GET /api/admin/briefings  — 최근 브리핑 목록 반환 (최대 10건)
 * POST /api/admin/briefings — 새 브리핑 생성 (run.json 기반)
 * admin role 이중 검증: 미들웨어 + 핸들러 내 getServerSession.
 */
import { NextResponse }     from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions }      from '@/lib/auth';
import { readRecords }      from '@/server/hub/store-supabase';
import { generateBriefing } from '@/server/hub/briefing';

function unauthorized() {
  return NextResponse.json({ error: '인증 필요' }, { status: 401 });
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') return unauthorized();

  try {
    const briefings = await readRecords('briefing', { limit: 10 });
    return NextResponse.json(briefings);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') return unauthorized();

  try {
    const record = await generateBriefing();
    return NextResponse.json(record, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
