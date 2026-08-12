/**
 * GET /api/admin/analytics — 트래픽 집계(오늘/7일/30일) 반환. admin 전용.
 * 이중 게이트: 미들웨어(/api/admin/* admin role) + 핸들러 getServerSession.
 * 데이터 = Supabase traffic_summary RPC(서버사이드 집계). 우리 DB가 단일 진실원천.
 */
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { pgRpcJson } from '@/lib/traffic';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function unauthorized() {
  return NextResponse.json({ error: '인증 필요' }, { status: 401 });
}

/** UTC 기준 N일 전 날짜(YYYY-MM-DD). */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') return unauthorized();

  const today = daysAgo(0);
  try {
    const [d1, d7, d30] = await Promise.all([
      pgRpcJson('traffic_summary', { p_from: today, p_to: today }),
      pgRpcJson('traffic_summary', { p_from: daysAgo(6), p_to: today }),
      pgRpcJson('traffic_summary', { p_from: daysAgo(29), p_to: today }),
    ]);
    return NextResponse.json({ today: d1, last7: d7, last30: d30 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
