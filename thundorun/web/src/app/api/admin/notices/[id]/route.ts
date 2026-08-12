/**
 * /api/admin/notices/[id] — 공지 수정 · 삭제 (admin 전용)
 *
 * PATCH  /api/admin/notices/[id] → { title?, body?, pinned? } 부분 수정
 * DELETE /api/admin/notices/[id] → 삭제
 *
 * 인증: getServerSession role==='admin' (미들웨어 + 핸들러 이중)
 * 고정 5개 초과 시 DB 트리거가 PINNED_LIMIT_EXCEEDED 로 거부 → 409 매핑.
 * 성공 시 홈(/, ISR)이 즉시 반영되도록 revalidatePath('/') 호출.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession }          from 'next-auth';
import { revalidatePath }            from 'next/cache';
import { authOptions }               from '@/lib/auth';
import { getSupabase }               from '@/lib/supabase';

function unauth() {
  return NextResponse.json({ error: '인증 필요' }, { status: 401 });
}

function isPinnedLimitError(error: { message?: string } | null): boolean {
  return !!error?.message?.includes('PINNED_LIMIT_EXCEEDED');
}

// ── PATCH (수정) ───────────────────────────────────────────────────────────────
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') return unauth();

  const db = getSupabase();
  if (!db) return NextResponse.json({ error: 'DB 미연결' }, { status: 503 });

  const { id } = await params;

  let body: { title?: string; body?: string; pinned?: boolean };
  try { body = await req.json() as typeof body; }
  catch { return NextResponse.json({ error: '잘못된 JSON' }, { status: 400 }); }

  const patch: { title?: string; body?: string; pinned?: boolean } = {};
  if (body.title !== undefined) {
    const title = body.title.trim();
    if (!title) return NextResponse.json({ error: '제목 필수' }, { status: 400 });
    patch.title = title;
  }
  if (body.body !== undefined) {
    const text = body.body.trim();
    if (!text) return NextResponse.json({ error: '본문 필수' }, { status: 400 });
    patch.body = text;
  }
  if (body.pinned !== undefined) patch.pinned = body.pinned;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: '변경할 필드 없음' }, { status: 400 });
  }

  const { data, error } = await db
    .from('notices')
    .update(patch)
    .eq('id', id)
    .select('id, title, body, pinned, pinned_at, author, created_at, updated_at')
    .maybeSingle();

  if (error) {
    if (isPinnedLimitError(error)) {
      return NextResponse.json({ error: '고정은 최대 5개까지입니다.' }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: '공지 없음' }, { status: 404 });

  revalidatePath('/');
  return NextResponse.json({ ok: true, notice: data });
}

// ── DELETE ────────────────────────────────────────────────────────────────────
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') return unauth();

  const db = getSupabase();
  if (!db) return NextResponse.json({ error: 'DB 미연결' }, { status: 503 });

  const { id } = await params;

  const { error } = await db.from('notices').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  revalidatePath('/');
  return NextResponse.json({ ok: true, deleted: id });
}
