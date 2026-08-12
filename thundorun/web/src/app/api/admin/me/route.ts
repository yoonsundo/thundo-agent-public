/**
 * GET /api/admin/me — 현재 세션 정보(role 포함) 반환
 * AdminDashboard 의 인증 상태 확인에 사용.
 */
import { NextResponse }     from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions }      from '@/lib/auth';

export async function GET() {
  const session = await getServerSession(authOptions);

  if (!session || session.user?.role !== 'admin') {
    return NextResponse.json({ error: '인증 필요' }, { status: 401 });
  }

  return NextResponse.json({
    id:   session.user?.name  ?? session.user?.email,
    role: session.user?.role,
  });
}
