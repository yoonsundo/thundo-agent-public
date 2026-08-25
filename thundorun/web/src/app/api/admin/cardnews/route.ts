/**
 * /api/admin/cardnews — 카드뉴스 반자동 발행 (관리자 전용)
 *   GET  -> 목록(ready + published, 캡션 포함)
 *   POST -> { post_id, action: 'publish', permalink } 발행 완료 → 공개로 전환
 *           { post_id, action: 'unpublish' }          발행 취소 → 다시 감춤
 *
 * 왜 반자동인가: 인스타 캐러셀에 **음악을 넣을 수 없어** 완전 자동 발행을 포기했다
 * (2026-08-21 사용자 결정). 파이프라인은 제작·호스팅까지만 하고, 관리자가 화면에서 확인해
 * 인스타에 직접 올린 뒤 이 API 로 공개 전환한다. 그 전까지는 일반 사용자에게 보이지 않는다.
 *
 * admin role 이중 검증(미들웨어 + 이 핸들러). DB 접근은 server/cardnews.ts 가 service_role 로.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession }          from 'next-auth';
import { authOptions }               from '@/lib/auth';
import { getAdminCardnews, markCardnewsPublished, unpublishCardnews } from '@/server/cardnews';

export const dynamic = 'force-dynamic';

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  return Boolean(session && session.user?.role === 'admin');
}

const unauthorized = () => NextResponse.json({ error: '인증 필요' }, { status: 401 });

export async function GET() {
  if (!(await requireAdmin())) return unauthorized();
  return NextResponse.json(await getAdminCardnews());
}

export async function POST(req: NextRequest) {
  if (!(await requireAdmin())) return unauthorized();

  let body: { post_id?: string; action?: string; permalink?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: '본문이 JSON 이 아니다' }, { status: 400 });
  }

  const postId = String(body.post_id ?? '').trim();
  if (!postId) return NextResponse.json({ error: 'post_id 가 필요하다' }, { status: 400 });

  if (body.action === 'unpublish') {
    const r = await unpublishCardnews(postId);
    return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.error }, { status: 400 });
  }

  if (body.action === 'publish') {
    // permalink 는 사람이 붙여넣는 값이라 서버에서 형식을 강제한다 — 클라이언트 검사만 믿지 않는다.
    const r = await markCardnewsPublished(postId, String(body.permalink ?? ''));
    return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.error }, { status: 400 });
  }

  return NextResponse.json({ error: "action 은 'publish' 또는 'unpublish' 여야 한다" }, { status: 400 });
}
