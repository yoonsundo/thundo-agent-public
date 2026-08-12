/**
 * GET  /api/admin/profile — 현재 프로필 반환
 * POST /api/admin/profile — 프로필 저장 (upsert)
 * admin role 이중 검증 (미들웨어 + 핸들러)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession }          from 'next-auth';
import { authOptions }               from '@/lib/auth';
import { getProfile, saveProfile }   from '@/server/siteProfile';
import type { SiteProfileData }      from '@/server/siteProfile';

function unauthorized() {
  return NextResponse.json({ error: '인증 필요' }, { status: 401 });
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') return unauthorized();

  const profile = await getProfile();
  return NextResponse.json(profile);
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') return unauthorized();

  let body: Partial<SiteProfileData>;
  try {
    body = await req.json() as Partial<SiteProfileData>;
  } catch {
    return NextResponse.json({ error: '잘못된 JSON 바디' }, { status: 400 });
  }

  // 최소 필드 검증
  if (!body.name?.trim() || !body.title?.trim()) {
    return NextResponse.json({ error: 'name, title 필드 필수' }, { status: 400 });
  }

  // 현재 프로필 읽어 병합 (일부 필드만 전송해도 나머지 유지)
  const current = await getProfile();
  const merged: SiteProfileData = {
    ...current,
    ...body,
    skills:  Array.isArray(body.skills)  ? body.skills  : current.skills,
    socials: Array.isArray(body.socials) ? body.socials : current.socials,
  };

  const result = await saveProfile(merged);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  return NextResponse.json({ ok: true, profile: merged });
}
