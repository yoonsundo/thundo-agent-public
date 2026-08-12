/**
 * /api/admin/notices — 공지 목록 조회 · 생성 (admin 전용)
 *
 * GET  /api/admin/notices → 전체 목록 (고정 우선)
 * POST /api/admin/notices → 생성 { title, body, pinned? }
 *
 * 인증: getServerSession role==='admin' (미들웨어 + 핸들러 이중)
 * 고정 5개 초과 시 DB 트리거가 PINNED_LIMIT_EXCEEDED 로 거부 → 409 매핑.
 * 생성 성공 시 홈(/, ISR)이 즉시 반영되도록 revalidatePath('/') 호출.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession }          from 'next-auth';
import { revalidatePath }            from 'next/cache';
import { authOptions }               from '@/lib/auth';
import { getSupabase }               from '@/lib/supabase';
import { getAllNotices }             from '@/server/notices';

function unauth() {
  return NextResponse.json({ error: '인증 필요' }, { status: 401 });
}

function isPinnedLimitError(error: { message?: string } | null): boolean {
  return !!error?.message?.includes('PINNED_LIMIT_EXCEEDED');
}

// ── GET ──────────────────────────────────────────────────────────────────────
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') return unauth();

  const rows = await getAllNotices();
  return NextResponse.json(rows);
}

// ── POST (생성) ────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') return unauth();

  const db = getSupabase();
  if (!db) return NextResponse.json({ error: 'DB 미연결' }, { status: 503 });

  let body: { title?: string; body?: string; pinned?: boolean };
  try { body = await req.json() as typeof body; }
  catch { return NextResponse.json({ error: '잘못된 JSON' }, { status: 400 }); }

  const title  = body.title?.trim();
  const text   = body.body?.trim();
  const pinned = body.pinned ?? false;
  if (!title || !text) {
    return NextResponse.json({ error: '제목·본문 필수' }, { status: 400 });
  }

  const row = { title, body: text, pinned, author: session.user?.email ?? null };

  const { data, error } = await db
    .from('notices')
    .insert(row)
    .select('id, title, body, pinned, pinned_at, author, created_at, updated_at')
    .single();

  if (error) {
    if (isPinnedLimitError(error)) {
      return NextResponse.json({ error: '고정은 최대 5개까지입니다.' }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  revalidatePath('/');
  return NextResponse.json({ ok: true, notice: data }, { status: 201 });
}
