/**
 * /api/publish — 외부 자동화 에이전트용 블로그 발행 API (API 키 인증).
 *
 * POST /api/publish  → 마크다운 글 1건을 blog_posts 에 발행(또는 덮어쓰기)
 * GET  /api/publish  → 요청 스키마·사용법(기계가 읽을 수 있는 self-describing 문서)
 *
 * 인증: `Authorization: Bearer <BLOG_PUBLISH_API_KEY>` 또는 `x-api-key: <key>` 헤더.
 * 미들웨어(/api/admin 만 매칭)는 이 경로를 건드리지 않으므로 핸들러 내에서 인증한다.
 * 본문은 마크다운으로 받아 파이프라인과 동일한 mdToHtml 로 변환(본문 escape → XSS 안전).
 *
 * ⚠ 15종 품질 게이트는 Vercel 런타임에서 실행 불가 — 본 API 는 포맷/스키마 검증만 한다.
 *    품질(길이·표절·AI티 등)은 호출하는 에이전트가 사전 보장해야 한다.
 */
import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { getSupabase } from '@/lib/supabase';
import { mdToHtml } from '@/lib/md-to-html';
import { slugify, deriveDescription, isValidDate, todayISODate } from '@/lib/publish-format';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_CONTENT = 200_000;   // 마크다운 원문 최대 길이(문자)
const MAX_TITLE = 200;
const MAX_TAGS = 20;

function json(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status });
}

/** 상수시간 비교로 제공된 키가 설정된 키와 일치하는지. */
function keyMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function extractKey(req: NextRequest): string {
  const auth = req.headers.get('authorization') ?? '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return (req.headers.get('x-api-key') ?? '').trim();
}

// ── POST: 발행 ────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const expected = process.env.BLOG_PUBLISH_API_KEY;
  if (!expected) return json(503, { ok: false, error: '발행 API가 설정되지 않았습니다(운영자에게 BLOG_PUBLISH_API_KEY 설정 요청).' });

  const provided = extractKey(req);
  if (!provided || !keyMatches(provided, expected)) {
    return json(401, { ok: false, error: 'API 키 인증 실패 — Authorization: Bearer <키> 헤더를 확인하세요.' });
  }

  const db = getSupabase();
  if (!db) return json(503, { ok: false, error: 'DB 미연결' });

  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; }
  catch { return json(400, { ok: false, error: '잘못된 JSON 본문입니다.' }); }

  // title
  const title = String(body.title ?? '').trim();
  if (!title) return json(400, { ok: false, error: 'title 은 필수입니다.' });
  if (title.length > MAX_TITLE) return json(400, { ok: false, error: `title 이 너무 깁니다(최대 ${MAX_TITLE}자).` });

  // content (markdown)
  const rawContent = String(body.content ?? '');
  if (!rawContent.trim()) return json(400, { ok: false, error: 'content(마크다운) 는 필수입니다.' });
  if (rawContent.length > MAX_CONTENT) return json(400, { ok: false, error: `content 가 너무 깁니다(최대 ${MAX_CONTENT}자).` });

  // slug (미지정 시 title 에서 생성 — 한글 등은 slugify 로 제거되므로 영문 slug 명시 권장)
  const slug = slugify(body.slug != null ? String(body.slug) : title);
  if (!slug) {
    return json(400, { ok: false, error: '유효한 slug 를 만들 수 없습니다. 영소문자·숫자·하이픈으로 된 slug 를 명시해 주세요(예: "my-post-title").' });
  }

  // status
  const status = body.status === 'draft' ? 'draft' : 'published';

  // date
  const date = body.date != null ? String(body.date) : todayISODate(new Date());
  if (!isValidDate(date)) return json(400, { ok: false, error: 'date 형식은 YYYY-MM-DD 이어야 합니다.' });

  // tags
  let tags: string[] = [];
  if (body.tags != null) {
    if (!Array.isArray(body.tags) || body.tags.some((t) => typeof t !== 'string')) {
      return json(400, { ok: false, error: 'tags 는 문자열 배열이어야 합니다.' });
    }
    tags = (body.tags as string[]).map((t) => t.trim()).filter(Boolean).slice(0, MAX_TAGS);
  }

  // description (미지정 시 본문 첫 문단에서 도출)
  const description = body.description != null
    ? String(body.description).trim().slice(0, 200)
    : deriveDescription(rawContent);

  // markdown → semantic HTML (파이프라인과 동일; 본문 escape 로 스크립트 주입 차단)
  const content = mdToHtml(rawContent);
  if (!content.trim()) return json(400, { ok: false, error: '변환된 본문이 비었습니다(마크다운 형식을 확인하세요).' });

  // slug 충돌 — 기본은 덮어쓰기 거부(409). overwrite:true 면 갱신.
  const overwrite = body.overwrite === true;
  const { data: existing } = await db.from('blog_posts').select('slug').eq('slug', slug).maybeSingle();
  if (existing && !overwrite) {
    return json(409, { ok: false, error: `이미 존재하는 slug 입니다: "${slug}". 갱신하려면 overwrite:true 를 보내세요.`, slug });
  }

  const now = new Date().toISOString();
  const row = { slug, title, date, status, description, tags, content, updated_at: now };
  const { data, error } = await db
    .from('blog_posts')
    .upsert(row, { onConflict: 'slug' })
    .select('slug, title, date, status')
    .single();

  if (error) {
    console.error('[publish] upsert 실패', { slug, message: error.message });
    return json(500, { ok: false, error: '발행 중 오류가 발생했습니다. 잠시 후 다시 시도하세요.' });
  }

  return json(existing ? 200 : 201, {
    ok: true,
    slug,
    status: data?.status ?? status,
    url: `https://www.thundo.kr/blog/${slug}`,
    overwritten: !!existing,
  });
}

// ── GET: 스키마·사용법(self-describing) ────────────────────────────────────────
export function GET() {
  return json(200, {
    name: 'thundo blog publish API',
    method: 'POST',
    endpoint: '/api/publish',
    auth: { header: 'Authorization: Bearer <API_KEY>', alt: 'x-api-key: <API_KEY>' },
    content_type: 'application/json',
    body_schema: {
      title:       { type: 'string', required: true, max: MAX_TITLE, desc: '글 제목' },
      content:     { type: 'string(markdown)', required: true, max: MAX_CONTENT, desc: '마크다운 본문. 서버가 시맨틱 HTML 로 변환(본문은 escape 됨).' },
      slug:        { type: 'string', required: false, desc: '영소문자·숫자·하이픈. 미지정 시 title 에서 생성(한글 제목은 slug 명시 권장).' },
      description: { type: 'string', required: false, max: 200, desc: '메타 설명. 미지정 시 본문 첫 문단에서 자동 도출.' },
      tags:        { type: 'string[]', required: false, max_items: MAX_TAGS, desc: '태그 목록' },
      date:        { type: 'string(YYYY-MM-DD)', required: false, desc: '발행일. 미지정 시 오늘(UTC).' },
      status:      { type: '"published" | "draft"', required: false, default: 'published' },
      overwrite:   { type: 'boolean', required: false, default: false, desc: '기존 slug 덮어쓰기 허용 여부(false 면 중복 시 409).' },
    },
    responses: {
      '201': '신규 발행 성공 → { ok, slug, url, status, overwritten:false }',
      '200': '기존 글 갱신 성공(overwrite:true) → { ok, slug, url, status, overwritten:true }',
      '400': '검증 실패(필수 누락·형식 오류)',
      '401': 'API 키 인증 실패',
      '409': 'slug 중복(overwrite:true 없이)',
      '503': 'API 미설정 또는 DB 미연결',
    },
    example: {
      curl: 'curl -X POST https://www.thundo.kr/api/publish -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d \'{"title":"제목","slug":"my-post","content":"## 소제목\\n\\n본문 문단...","tags":["AI","자동화"]}\'',
    },
    notes: [
      '품질 게이트(길이·표절·AI티 등 15종)는 이 API 에서 실행되지 않는다 — 호출자가 사전 보장할 것.',
      'content 는 마크다운으로 보낸다. 원시 HTML 을 넣어도 텍스트로 escape 되어 렌더되지 않는다.',
      '이미지는 외부 URL(https)만 사용 가능(blog-publisher 로컬 /images 경로는 렌더 안 됨).',
    ],
  });
}
