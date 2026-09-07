/**
 * /api/admin/blog — 블로그 CRUD (admin 전용)
 *
 * GET   /api/admin/blog           → 전체 목록 (draft·ready 포함 — 승인하려면 보여야 한다)
 * GET   /api/admin/blog?slug=xxx  → 단건 (content 포함)
 * POST  /api/admin/blog           → upsert { slug, title, date, status, description, tags, content }
 * PATCH /api/admin/blog           → 상태만 변경 { slug, status }  ← 승인·승인취소
 * DELETE /api/admin/blog?slug=xx  → 삭제
 *
 * 🔴 이 라우트는 **관리 경로**다 — 공개 경로(lib/blog.ts)와 달리 승인 대기(ready)도 준다.
 *    승인하려면 봐야 하기 때문이다. 공개 경계는 여기가 아니라 lib/blog.ts 에 있다.
 *
 * 왜 PATCH 를 따로 두나: 승인은 목록 화면에서 일어나는데 목록에는 content 가 없다.
 * upsert 로 승인하면 본문을 먼저 받아왔다가 되돌려보내야 하고, 그 왕복 어딘가에서
 * 본문이 잘리면 **승인 클릭 한 번이 글을 지우는 사고**가 된다. 상태만 바꾸는 문을 연다.
 *
 * 인증: getServerSession role==='admin' (미들웨어 + 핸들러 이중)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession }          from 'next-auth';
import { authOptions }               from '@/lib/auth';
import { getSupabase }               from '@/lib/supabase';
import { getBlogViewMap }            from '@/server/blogViews';
import { revalidateBlog }            from '@/server/blogCache';
import { normalizeStatus, type BlogStatus } from '@/lib/blog-status';

function unauth() {
  return NextResponse.json({ error: '인증 필요' }, { status: 401 });
}

/** 승인자 식별자 — admin/page.tsx 와 같은 관용구(name → email → '관리자'). */
function approverId(session: { user?: { name?: string | null; email?: string | null } } | null): string {
  return session?.user?.name ?? session?.user?.email ?? '관리자';
}

/**
 * 승인 흔적. published 로 올릴 때만 채우고, 벗어나면 **지운다**.
 * 공개되지 않은 글에 검수자 이름이 남아 있으면 US-004 의 "검수자 표시"가 거짓을 말한다.
 * 미승인·기록 이전은 빈 문자열이 아니라 null 이다("승인자 없음"과 "측정 못 함"의 구분).
 */
// 반환형을 명시한다 — 분기별 리터럴 유니온으로 추론되면 upsert 인자 타입이 갈라진다.
function approvalPatch(
  status: BlogStatus, approver: string, now: string,
): { approved_by: string | null; approved_at: string | null } {
  return status === 'published'
    ? { approved_by: approver, approved_at: now }
    : { approved_by: null,     approved_at: null };
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
      .select('slug, title, date, status, description, tags, content, created_at, updated_at, approved_by, approved_at')
      .eq('slug', slug)
      .maybeSingle();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data)  return NextResponse.json({ error: '글 없음' }, { status: 404 });
    return NextResponse.json(data);
  }

  // 전체 목록 (content 제외) + 글별 조회수(traffic_pv 합산) 부착
  const { data, error } = await db
    .from('blog_posts')
    .select('slug, title, date, status, description, tags, created_at, updated_at, approved_by, approved_at')
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

  const { slug, title, date, description = '', tags = [], content = '' } = body;
  if (!slug?.trim() || !title?.trim()) {
    return NextResponse.json({ error: 'slug, title 필수' }, { status: 400 });
  }
  // 화이트리스트 — 모르는 값을 공개로 올리지 않는다. 미지정은 초안(사람이 만드는 새 글).
  const status = normalizeStatus(body.status, 'draft');

  const now  = new Date().toISOString();
  const row  = {
    slug, title, date: date ?? now.slice(0, 10), status, description, tags, content, updated_at: now,
    ...approvalPatch(status, approverId(session), now),
  };

  const { data, error } = await db
    .from('blog_posts')
    .upsert(row, { onConflict: 'slug' })
    .select('slug, title, date, status, approved_by, approved_at')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  revalidateBlog(slug);
  return NextResponse.json({ ok: true, post: data }, { status: 200 });
}

// ── PATCH (상태만 변경 = 승인/승인취소) ───────────────────────────────────────
export async function PATCH(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') return unauth();

  const db = getSupabase();
  if (!db) return NextResponse.json({ error: 'DB 미연결' }, { status: 503 });

  let body: { slug?: string; status?: string };
  try { body = await req.json() as typeof body; }
  catch { return NextResponse.json({ error: '잘못된 JSON' }, { status: 400 }); }

  const slug = String(body.slug ?? '').trim();
  if (!slug) return NextResponse.json({ error: 'slug 필수' }, { status: 400 });

  // fallback 없이 **명시된 값만** 받는다 — 오타('publish')가 조용히 기본값으로 처리되면
  // 관리자는 승인했다고 믿는데 글은 그대로인(혹은 반대인) 화면이 된다.
  const status = normalizeStatus(body.status, 'draft');
  if (status !== String(body.status ?? '').trim().toLowerCase()) {
    return NextResponse.json({ error: "status 는 'draft' | 'ready' | 'published' 중 하나여야 합니다" }, { status: 400 });
  }

  const now = new Date().toISOString();
  // .select() 로 갱신된 행을 되받는다 — 없는 slug 는 Supabase 가 오류를 주지 않아서,
  // 이게 없으면 오타 slug 로도 "승인 완료"가 뜬다(화면은 승인됐다는데 DB 는 그대로).
  const { data, error } = await db
    .from('blog_posts')
    .update({ status, updated_at: now, ...approvalPatch(status, approverId(session), now) })
    .eq('slug', slug)
    .select('slug, title, date, status, approved_by, approved_at');

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!Array.isArray(data) || data.length === 0) {
    return NextResponse.json({ error: `해당 글을 찾지 못했습니다: ${slug}` }, { status: 404 });
  }
  // 승인·승인취소 양쪽 모두 무효화한다 — 되돌릴 때 캐시가 남으면 내렸는데 계속 보인다.
  revalidateBlog(slug);
  return NextResponse.json({ ok: true, post: data[0] });
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
  revalidateBlog(slug);
  return NextResponse.json({ ok: true, deleted: slug });
}
