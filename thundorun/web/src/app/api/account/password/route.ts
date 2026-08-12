/**
 * POST /api/account/password — 로그인 사용자 본인 비밀번호 변경
 *
 * 흐름: 세션 검증 → body 파싱 → SERVICE_ROLE db 확보 → changePassword(현재비번 검증 후 갱신).
 * 미들웨어(/api/account 로그인 게이트)가 1차 방어, 여기서 세션 재검증(defense-in-depth).
 * scrypt 사용 → Node 런타임 필수(edge 미지정).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getSupabase } from '@/lib/supabase';
import { hashPassword, verifyPassword } from '@/lib/authScrypt';
import { changePassword } from '@/server/accountPassword';

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401 });
  }

  // auth.ts 에서 name==email==admin_users.id 로 설정됨.
  const userId = session.user?.name ?? session.user?.email ?? '';
  if (!userId) {
    return NextResponse.json({ error: '세션 정보가 올바르지 않습니다.' }, { status: 401 });
  }

  let body: { currentPassword?: string; newPassword?: string };
  try {
    body = (await req.json()) as { currentPassword?: string; newPassword?: string };
  } catch {
    return NextResponse.json({ error: '잘못된 요청입니다.' }, { status: 400 });
  }

  const db = getSupabase();
  if (!db) {
    return NextResponse.json({ error: '서버 설정 오류로 비밀번호를 변경할 수 없습니다.' }, { status: 503 });
  }

  const result = await changePassword(
    db,
    userId,
    body.currentPassword ?? '',
    body.newPassword ?? '',
    { verify: verifyPassword, hash: hashPassword },
  );

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true });
}
