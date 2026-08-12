import { NextRequest, NextResponse } from 'next/server';
import { resolveAccessCode, accessCodeToken } from '@/lib/accessCode';

export async function POST(req: NextRequest) {
  let body: { code?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: '요청 형식이 올바르지 않습니다.' }, { status: 400 });
  }

  const accessCode = resolveAccessCode();
  // 게이트 비활성 상태(로컬 dev)면 통과
  if (!accessCode) return NextResponse.json({ ok: true });

  if ((body.code ?? '').trim() !== accessCode) {
    return NextResponse.json({ error: '코드가 올바르지 않습니다.' }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set('saju_gate', await accessCodeToken(accessCode), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 30,
    path: '/',
  });
  return res;
}
