/**
 * GET /api/admin/timeline — 전체 이벤트 타임라인 (최대 100건, 최신순)
 * admin role 이중 검증.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession }          from 'next-auth';
import { authOptions }               from '@/lib/auth';
import { timeline }                  from '@/server/hub/store-supabase';

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') {
    return NextResponse.json({ error: '인증 필요' }, { status: 401 });
  }

  const url   = new URL(req.url);
  const limit = parseInt(url.searchParams.get('limit') ?? '100', 10);

  try {
    const records = await timeline({ limit: Math.min(limit, 200) });
    return NextResponse.json(records);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
