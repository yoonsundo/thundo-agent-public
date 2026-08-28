import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getSupabase } from '@/lib/supabase';

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') return NextResponse.json({ error: '인증 필요' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const page  = Math.max(1, parseInt(searchParams.get('page')  ?? '1'));
  const limit = Math.min(50, parseInt(searchParams.get('limit') ?? '20'));
  const from  = (page - 1) * limit;

  const db = getSupabase();
  if (!db) {
    return NextResponse.json({ items: [], total: 0, configured: false });
  }

  const { data, count, error } = await db
    .from('saju_readings')
    .select('id, name, birth_date, birth_time, gender, fortune_types, result, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, from + limit - 1);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ items: data ?? [], total: count ?? 0, configured: true });
}

/**
 * DELETE ?id= — 조회 이력 1건 삭제 (관리자 전용, 아몬드 대시보드).
 * `.select()` 로 삭제된 행을 되받는다 — 없는 id 는 Supabase 가 오류를 주지 않아서,
 * 이게 없으면 오타 id 로도 "삭제 완료"가 뜬다(cardnews 발행 전환과 같은 패턴).
 */
export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') return NextResponse.json({ error: '인증 필요' }, { status: 401 });

  const id = String(new URL(req.url).searchParams.get('id') ?? '').trim();
  if (!id) return NextResponse.json({ error: 'id 가 필요하다' }, { status: 400 });

  const db = getSupabase();
  if (!db) return NextResponse.json({ error: 'DB 연결 없음' }, { status: 500 });

  const { data, error } = await db.from('saju_readings').delete().eq('id', id).select('id');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!Array.isArray(data) || data.length === 0) {
    return NextResponse.json({ error: '해당 이력을 찾지 못했다' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
