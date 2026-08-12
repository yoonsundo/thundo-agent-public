/**
 * /api/admin/blog — 블로그 CRUD (admin 전용)
 *
 * GET  /api/admin/blog           → 전체 목록 (draft 포함)
 * GET  /api/admin/blog?slug=xxx  → 단건 (content 포함)
 * POST /api/admin/blog           → upsert { slug, title, date, status, description, tags, content }
 * DELETE /api/admin/blog?slug=xx → 삭제
 *
 * 인증: getServerSession role==='admin' (미들웨어 + 핸들러 이중)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession }          from 'next-auth';
import { authOptions }               from '@/lib/auth';
import { getSupabase }               from '@/lib/supabase';
import { getBlogViewMap }            from '@/server/blogViews';

function unauth() {
  return NextResponse.json({ error: '인증 필요' }, { status: 401 });
}

// ── GET ──────────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') return unauth();

  const db   = getSupabase();
  const slug = new URL(req.url).searchParams.get('slug');

  if (!db) return NextResponse.json({ error: 'DB 미연결' }, { status: 503 });

  if (slug) {
    // 단건 조회 (content 포함, draft 도 허용)
    const { data, error } = await db
      .from('blog_posts')
      .select('slug, title, date, status, description, tags, content, created_at, updated_at')
      .eq('slug', slug)
      .maybeSingle();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data)  return NextResponse.json({ error: '글 없음' }, { status: 404 });
    return NextResponse.json(data);
  }

  // 전체 목록 (content 제외) + 글별 조회수(traffic_pv 합산) 부착
  const { data, error } = await db
    .from('blog_posts')
    .select('slug, title, date, status, description, tags, created_at, updated_at')
    .order('date', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const viewMap = await getBlogViewMap();
  const withViews = (data ?? []).map((p) => ({ ...p, views: viewMap[p.slug as string] ?? 0 }));
  return NextResponse.json(withViews);
}

// ── POST (upsert) ─────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') return unauth();

  const db = getSupabase();
  if (!db) return NextResponse.json({ error: 'DB 미연결' }, { status: 503 });

  let body: {
    slug?: string; title?: string; date?: string;
    status?: string; description?: string; tags?: string[];
    content?: string;
  };
  try { body = await req.json() as typeof body; }
  catch { return NextResponse.json({ error: '잘못된 JSON' }, { status: 400 }); }

  const { slug, title, date, status = 'draft', description = '', tags = [], content = '' } = body;
  if (!slug?.trim() || !title?.trim()) {
    return NextResponse.json({ error: 'slug, title 필수' }, { status: 400 });
  }

  const now  = new Date().toISOString();
  const row  = { slug, title, date: date ?? now.slice(0, 10), status, description, tags, content, updated_at: now };

  const { data, error } = await db
    .from('blog_posts')
    .upsert(row, { onConflict: 'slug' })
    .select('slug, title, date, status')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, post: data }, { status: 200 });
}

// ── DELETE ────────────────────────────────────────────────────────────────────
export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') return unauth();

  const db   = getSupabase();
  const slug = new URL(req.url).searchParams.get('slug');

  if (!db)    return NextResponse.json({ error: 'DB 미연결' }, { status: 503 });
  if (!slug)  return NextResponse.json({ error: 'slug 필수' }, { status: 400 });

  const { error } = await db.from('blog_posts').delete().eq('slug', slug);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, deleted: slug });
}
