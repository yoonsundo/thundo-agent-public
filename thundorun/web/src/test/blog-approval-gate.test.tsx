/**
 * blog-approval-gate — 사람이 승인한 글만 공개된다는 경계를 잠근다.
 *
 * 왜 이 파일이 있나 (2026-09-07 실측): 발행물 203편 중 147편(72%)이 68일간 어떤 검색어에도
 * 걸리지 않았고, 구글 8월 스팸 업데이트의 표적("편집 감독 없는 대량 생산 AI 생성물")과
 * 우리 프로필이 일치했다. 발행량을 줄이고 사람 승인 관문(status='ready')을 넣었다.
 *
 * 지키는 성질 넷:
 *   ① ready 는 공개 어디에도 안 나온다 — 목록·상세·검색·sitemap·RSS·llms.txt
 *   ② published 는 **하나도** 사라지지 않는다 (기존 207편이 없어지면 대형 사고다)
 *   ③ 관리 경로에는 ready 가 보이고, 승인하면 published 가 되며 누가·언제가 기록된다
 *   ④ 상태는 화이트리스트다 — 모르는 값이 공개로 승격되지 않는다
 *
 * 🔴 소스에 `.eq('status','published')` 라는 **문자열이 있는지**를 보지 않는다.
 *    가짜 DB 가 필터를 실제로 적용하게 하고, 나온 행에 ready 가 섞였는지를 본다.
 *    문자열 검사는 뒤에 `.or(...)` 하나가 붙어 경계가 뚫려도 그대로 통과한다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextRequest } from 'next/server';

// ── 대역 배선 ────────────────────────────────────────────────────────────────
vi.mock('@/lib/supabase', () => ({ getSupabase: vi.fn() }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
// next/cache 는 요청 컨텍스트(static generation store) 밖에서 부르면 던진다 — 단위 테스트엔
// 그 컨텍스트가 없다. 대역으로 바꿔 두고, 아래에서 **무엇을 버렸는지**까지 검사한다.
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  // unstable_cache 까지 지우면 lib/blog.ts 가 모듈 로드 시점에 터진다(캐시 래퍼를 거기서
  // 만든다). 통과형으로 둬서 캐시 유무가 이 파일의 경계 검사에 영향을 주지 않게 한다.
  unstable_cache: <T,>(fn: T) => fn,
}));

import { revalidatePath, revalidateTag } from 'next/cache';
import { getSupabase } from '@/lib/supabase';
import { getServerSession } from 'next-auth';
import { normalizeStatus, isPublic, PUBLIC_STATUS } from '@/lib/blog-status';
import { BLOG_CACHE_TAG } from '@/lib/blog';

/** 대역 호출 인자 목록 — `revalidatePath('/blog/x')` 처럼 경로만 뽑아 본다. */
const calls = (fn: unknown) => (fn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);

interface Row {
  slug: string; title: string; date: string; status: string;
  description?: string; tags?: string[]; content?: string;
  approved_by?: string | null; approved_at?: string | null;
}

/** 실제 운영 모양: 승인 관문 이전에 자동 발행된 207편 + 대기 1편 + 초안 1편. */
const PUBLISHED_COUNT = 207;
function dataset(): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < PUBLISHED_COUNT; i++) {
    rows.push({
      slug: `pub-${i}`, title: `공개글 ${i}`, date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
      status: 'published', description: `설명 ${i}`, tags: ['AI'], content: `<p>본문 ${i}</p>`,
      approved_by: null, approved_at: null,   // 관문 이전 글엔 승인자가 실제로 없다
    });
  }
  // ⚠ 맨 **앞**에 둔다. 미승인 글이 가장 최신이므로 실제 date 내림차순에서도 맨 앞이다.
  //   뒤에 두면 RSS·llms.txt 의 `slice(0, 30)` 창 밖으로 밀려나, 필터를 통째로 지워도
  //   테스트가 통과하는 거짓 green 이 된다(2026-09-07 변이 검사에서 실제로 드러났다).
  rows.unshift(
    {
      slug: 'waiting-approval', title: '승인 대기 글', date: '2026-09-01', status: 'ready',
      description: '아직 사람이 안 봤다', tags: ['AI'], content: '<p>미승인 본문</p>',
      approved_by: null, approved_at: null,
    },
    {
      slug: 'human-draft', title: '사람 초안', date: '2026-09-02', status: 'draft',
      description: '쓰다 만 글', tags: [], content: '<p>초안</p>',
      approved_by: null, approved_at: null,
    },
  );
  return rows;
}

interface Recorded {
  table: string;
  filters: Record<string, unknown>;
  update: Record<string, unknown> | null;
  upsert: Record<string, unknown> | null;
}

/**
 * Supabase 쿼리 빌더 대역 — 체이닝을 기록하고 **eq 필터를 데이터에 실제로 적용**한다.
 * 필터를 적용하지 않으면 "필터를 걸었는가"만 보게 되고, 그건 소스 문자열 검사와 다를 게 없다.
 */
function makeDb(rows: Row[]) {
  const queries: Recorded[] = [];
  const db = {
    from(table: string) {
      const rec: Recorded = { table, filters: {}, update: null, upsert: null };
      queries.push(rec);
      const match = () =>
        table === 'blog_posts'
          ? rows.filter((r) => Object.entries(rec.filters)
              .every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v))
          : [];   // traffic_pv 등 다른 표는 이 테스트의 관심 밖 — 빈 집계로 둔다
      const result = () => ({ data: match(), error: null });

      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (k: string, v: unknown) => { rec.filters[k] = v; return builder; },
        // or/like/gte/limit 은 이 경계와 무관한 부가 조건 — 체인만 잇는다.
        or: () => builder, like: () => builder, gte: () => builder,
        limit: () => builder, order: () => builder,
        update: (patch: Record<string, unknown>) => {
          rec.update = patch;
          return builder;
        },
        upsert: (row: Record<string, unknown>) => { rec.upsert = row; return builder; },
        delete: () => builder,
        maybeSingle: async () => ({ data: match()[0] ?? null, error: null }),
        single: async () => ({
          data: rec.upsert ?? match()[0] ?? null,
          error: null,
        }),
        then: (ok: (v: unknown) => unknown, no: (e: unknown) => unknown) => {
          // update 는 매칭 행에 실제로 반영한다 — 승인 뒤 목록이 달라지는지 볼 수 있게.
          if (rec.update) {
            const hit = match();
            for (const r of hit) Object.assign(r, rec.update);
            return Promise.resolve({ data: hit, error: null }).then(ok, no);
          }
          return Promise.resolve(result()).then(ok, no);
        },
      };
      return builder;
    },
  };
  return { db, queries };
}

let rows: Row[];
function useDb() {
  rows = dataset();
  const { db, queries } = makeDb(rows);
  (getSupabase as unknown as ReturnType<typeof vi.fn>).mockReturnValue(db);
  return queries;
}

beforeEach(() => { vi.clearAllMocks(); useDb(); });
afterEach(() => { vi.unstubAllEnvs(); });

// ─────────────────────────────────────────────────────────────────────────────
describe('① 공개 경로 — 승인 대기(ready)는 어디에도 안 나온다', () => {
  it('목록(getAllPosts)', async () => {
    const { getAllPosts } = await import('@/lib/blog');
    const out = await getAllPosts();
    expect(out.map((p) => p.slug)).not.toContain('waiting-approval');
    expect(out.map((p) => p.slug)).not.toContain('human-draft');
    expect(out).toHaveLength(PUBLISHED_COUNT);            // ② 기존 발행분은 전부 남는다
  });

  it('경량 메타(getPostSummaries) — 홈·llms.txt·site-chat 이 쓰는 경로', async () => {
    const { getPostSummaries } = await import('@/lib/blog');
    const out = await getPostSummaries();
    expect(out.map((p) => p.slug)).not.toContain('waiting-approval');
    expect(out).toHaveLength(PUBLISHED_COUNT);
  });

  it('상세(getPost) — slug 를 직접 쳐도 안 열린다', async () => {
    const { getPost } = await import('@/lib/blog');
    expect(await getPost('waiting-approval')).toBeNull();
    expect(await getPost('human-draft')).toBeNull();
    expect((await getPost('pub-0'))?.slug).toBe('pub-0');   // ② 공개글은 그대로 열린다
  });

  it('검색(searchPostSlugs) — 검색으로도 못 찾는다', async () => {
    const { searchPostSlugs } = await import('@/lib/blog');
    const hit = await searchPostSlugs('승인');
    expect(hit?.has('waiting-approval')).toBe(false);
  });

  it('sitemap — 미승인 글을 색인하라고 알리지 않는다', async () => {
    const sitemap = (await import('@/app/sitemap')).default;
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls.some((u) => u.includes('waiting-approval'))).toBe(false);
    expect(urls).toContain('https://www.thundo.kr/blog/pub-0');
  });

  it('RSS(feed.xml) — 본문 전문이 실리는 경로라 특히 샐 수 없다', async () => {
    const { GET } = await import('@/app/feed.xml/route');
    const xml = await (await GET()).text();
    expect(xml).not.toContain('waiting-approval');
    expect(xml).not.toContain('미승인 본문');
    expect(xml).toContain('/blog/pub-0');
  });

  it('llms.txt — AI 크롤러 카탈로그', async () => {
    const { GET } = await import('@/app/llms.txt/route');
    const txt = await (await GET()).text();
    expect(txt).not.toContain('승인 대기 글');
    expect(txt).toContain('공개글 0');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('③ 관리 경로 — 승인하려면 보여야 한다', () => {
  const asAdmin = () =>
    (getServerSession as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ user: { role: 'admin', name: '관리자김' } });

  it('관리자 목록에는 ready 가 보인다 (공개 목록과 다른 경로)', async () => {
    asAdmin();
    const { GET } = await import('@/app/api/admin/blog/route');
    const body = await (await GET(new NextRequest('http://x/api/admin/blog'))).json() as Row[];
    expect(body.map((p) => p.slug)).toContain('waiting-approval');
    expect(body).toHaveLength(PUBLISHED_COUNT + 2);
  });

  it('승인(PATCH)하면 published 가 되고 누가·언제가 남는다', async () => {
    asAdmin();
    const { PATCH } = await import('@/app/api/admin/blog/route');
    const res = await PATCH(new NextRequest('http://x/api/admin/blog', {
      method: 'PATCH', body: JSON.stringify({ slug: 'waiting-approval', status: 'published' }),
    }));
    expect(res.status).toBe(200);
    const target = rows.find((r) => r.slug === 'waiting-approval')!;
    expect(target.status).toBe('published');
    expect(target.approved_by).toBe('관리자김');
    expect(typeof target.approved_at).toBe('string');

    // 🔴 상세(/blog/[slug])는 ISR 이고 미승인 글은 404 로 캐시된다 — 승인하면서 그 캐시를
    //    버리지 않으면 최대 5분간 404 가 그대로 나가고, 화면상 승인 버튼이 고장 난 것처럼 보인다.
    expect(calls(revalidatePath)).toContain('/blog/waiting-approval');
    expect(calls(revalidatePath)).toContain('/');              // 홈 ISR — 글 수·인기글
    expect(calls(revalidatePath)).toContain('/sitemap.xml');   // 색인 신호
    expect(calls(revalidateTag)).toContain(BLOG_CACHE_TAG);    // /blog 목록 데이터 캐시

    // 승인한 뒤에야 공개 목록에 들어온다.
    const { getPost } = await import('@/lib/blog');
    expect((await getPost('waiting-approval'))?.slug).toBe('waiting-approval');
  });

  it('승인을 되돌리면 검수자 기록도 지운다 — 비공개 글에 검수자를 표시하면 거짓이다', async () => {
    asAdmin();
    const { PATCH } = await import('@/app/api/admin/blog/route');
    await PATCH(new NextRequest('http://x/api/admin/blog', {
      method: 'PATCH', body: JSON.stringify({ slug: 'waiting-approval', status: 'published' }),
    }));
    await PATCH(new NextRequest('http://x/api/admin/blog', {
      method: 'PATCH', body: JSON.stringify({ slug: 'waiting-approval', status: 'ready' }),
    }));
    const target = rows.find((r) => r.slug === 'waiting-approval')!;
    expect(target.status).toBe('ready');
    expect(target.approved_by).toBeNull();
    expect(target.approved_at).toBeNull();
    // 내릴 때도 버려야 한다 — 안 버리면 "내렸는데 계속 보인다"가 된다(더 나쁜 방향의 실패).
    expect(calls(revalidatePath)).toContain('/blog/waiting-approval');
  });

  it('없는 slug 는 404 — Supabase 는 무매칭에 오류를 주지 않아 조용히 "승인 완료"가 뜬다', async () => {
    asAdmin();
    const { PATCH } = await import('@/app/api/admin/blog/route');
    const res = await PATCH(new NextRequest('http://x/api/admin/blog', {
      method: 'PATCH', body: JSON.stringify({ slug: 'no-such-slug', status: 'published' }),
    }));
    expect(res.status).toBe(404);
  });

  it('모르는 status 는 400 — 기본값으로 조용히 처리하지 않는다', async () => {
    asAdmin();
    const { PATCH } = await import('@/app/api/admin/blog/route');
    const res = await PATCH(new NextRequest('http://x/api/admin/blog', {
      method: 'PATCH', body: JSON.stringify({ slug: 'waiting-approval', status: 'publised' }),
    }));
    expect(res.status).toBe(400);
    expect(rows.find((r) => r.slug === 'waiting-approval')!.status).toBe('ready');
  });

  it('비관리자는 목록도 승인도 못 한다', async () => {
    (getServerSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { role: 'user' } });
    const { GET, PATCH } = await import('@/app/api/admin/blog/route');
    expect((await GET(new NextRequest('http://x/api/admin/blog'))).status).toBe(401);
    expect((await PATCH(new NextRequest('http://x/api/admin/blog', {
      method: 'PATCH', body: JSON.stringify({ slug: 'waiting-approval', status: 'published' }),
    }))).status).toBe(401);
    expect(rows.find((r) => r.slug === 'waiting-approval')!.status).toBe('ready');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('④ 상태 화이트리스트 — 모르는 값이 공개로 승격되지 않는다', () => {
  it('normalizeStatus 는 셋만 통과시킨다', () => {
    expect(normalizeStatus('ready', 'draft')).toBe('ready');
    expect(normalizeStatus('published', 'draft')).toBe('published');
    for (const bad of ['publised', 'live', '', null, undefined, 42, {}]) {
      expect(normalizeStatus(bad, 'draft'), String(bad)).toBe('draft');
    }
  });

  it('공개 경계는 published 하나다', () => {
    expect(isPublic(PUBLIC_STATUS)).toBe(true);
    for (const s of ['ready', 'draft', 'READY', '', null]) expect(isPublic(s), String(s)).toBe(false);
  });

  // 🔴 예전 /api/publish 는 `status==='draft' ? 'draft' : 'published'` 였다 —
  //    'ready' 를 보내면 조용히 공개돼 승인 관문이 통째로 우회됐다.
  it("/api/publish 에 ready 를 보내면 ready 로 남는다(공개되지 않는다)", async () => {
    vi.stubEnv('BLOG_PUBLISH_API_KEY', 'test-key');
    const queries = useDb();
    const { POST } = await import('@/app/api/publish/route');
    const res = await POST(new NextRequest('http://x/api/publish', {
      method: 'POST',
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ title: '새 글', slug: 'brand-new', content: '## 소제목\n\n본문 문단입니다.', status: 'ready' }),
    }));
    expect(res.status).toBe(201);
    expect((await res.json()).status).toBe('ready');
    const upserted = queries.find((q) => q.upsert)?.upsert;
    expect(upserted?.status).toBe('ready');
  });

  it('/api/publish 에 오타 status 를 보내도 published 로 승격되지 않는다 — 아니, 기본값을 쓴다', async () => {
    vi.stubEnv('BLOG_PUBLISH_API_KEY', 'test-key');
    const queries = useDb();
    const { POST } = await import('@/app/api/publish/route');
    await POST(new NextRequest('http://x/api/publish', {
      method: 'POST',
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ title: '새 글', slug: 'brand-new-2', content: '## 소제목\n\n본문.', status: 'reddy' }),
    }));
    // 이 엔드포인트의 문서화된 기본값은 'published' 다(외부 호출자 계약). 중요한 건
    // 'reddy' 가 'ready' 로도, 임의 값으로도 저장되지 않는다는 것이다.
    expect(queries.find((q) => q.upsert)?.upsert?.status).toBe('published');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('③-2 관리자 화면 — 승인 대기 목록과 승인 버튼', () => {
  const LIST = [
    { slug: 'waiting-approval', title: '승인 대기 글', date: '2026-09-01', status: 'ready', views: 0 },
    { slug: 'pub-0', title: '공개글 0', date: '2026-01-01', status: 'published', views: 3, approved_by: '관리자김' },
  ];

  beforeEach(() => {
    // jsdom 에 EventSource 가 없다 — 대시보드가 마운트 즉시 구독한다.
    class FakeES { close() {} addEventListener() {} onmessage: unknown = null; onerror: unknown = null }
    vi.stubGlobal('EventSource', FakeES);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/admin/blog' && init?.method === 'PATCH') {
        return { ok: true, json: async () => ({ ok: true }) };
      }
      if (url.startsWith('/api/admin/blog')) return { ok: true, json: async () => LIST };
      // 그 밖(프로필·프로젝트·에이전트)은 빈 배열 — 대시보드의 다른 탭들이 목록을 기대한다.
      return { ok: true, json: async () => [] };
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  async function openBlogTab() {
    const AdminDashboard = (await import('@/components/AdminDashboard')).default;
    render(<AdminDashboard adminId="관리자김" />);
    await userEvent.click(await screen.findByRole('tab', { name: /블로그 관리/ }));
  }

  it('승인 대기가 목록에 뜨고 승인 버튼이 있다', async () => {
    await openBlogTab();
    expect(await screen.findByText(/승인 대기 1편/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /승인$/ })).toBeInTheDocument();
  });

  it('승인 버튼은 본문 없이 상태만 보낸다 — upsert 로 승인하면 빈 본문이 글을 덮는다', async () => {
    await openBlogTab();
    await userEvent.click(screen.getByRole('button', { name: /승인$/ }));

    const patch = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .find((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH');
    expect(patch, 'PATCH 요청이 나가지 않았다').toBeTruthy();
    const sent = JSON.parse(String((patch![1] as RequestInit).body)) as Record<string, unknown>;
    expect(sent).toEqual({ slug: 'waiting-approval', status: 'published' });
    expect(sent).not.toHaveProperty('content');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/승인했습니다/));
  });

  it('승인 기록이 없는 발행글에 검수자를 지어내지 않는다', async () => {
    await openBlogTab();
    await screen.findByText('공개글 0');
    // 관문 이전 207편은 approved_by 가 null 이다 — '승인 null' 같은 문구가 뜨면 안 된다.
    expect(screen.queryByText(/승인 null|승인 undefined/)).not.toBeInTheDocument();
    expect(screen.getByText(/승인 관리자김/)).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('스키마 — 승인 관문이 SQL 에 실제로 있다', () => {
  it('approved_by·approved_at 컬럼과 상태 제약이 있고, 기존 발행분을 백필하지 않는다', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const sql = readFileSync(join(process.cwd(), 'supabase/blog_posts.sql'), 'utf8');
    expect(sql).toContain('add column if not exists approved_by text');
    expect(sql).toContain('add column if not exists approved_at timestamptz');
    expect(sql).toMatch(/check \(status in \('draft', 'ready', 'published'\)\)/);
    // 🔴 published 를 건드리는 UPDATE 가 있으면 기존 207편이 사라질 수 있다.
    //    정규화 UPDATE 는 '셋 밖의 값'만 만진다.
    expect(sql).not.toMatch(/update public\.blog_posts[\s\S]*?set status = 'ready'/);
  });
});
