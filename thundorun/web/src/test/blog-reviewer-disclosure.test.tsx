/**
 * blog-reviewer-disclosure — "누가 언제 검수했는가"를 사람과 기계 둘 다에게 밝힌다.
 *
 * 배경(2026-09-07): 8월 구글 스팸 업데이트가 겨냥한 것은 AI 생성 자체가 아니라 "의미 있는
 * 사람 검토 없이 대량 생산된 것"이다. 사람 승인 관문은 이미 있고 `approved_by`·`approved_at`
 * 도 기록된다 — 남은 일은 그 사실을 드러내는 것이다.
 *
 * 🔴 이 파일이 가장 강하게 지키는 것은 표시가 아니라 **침묵**이다. 관문 이전에 자동 발행된
 *    207편에는 승인 기록이 없다(백필하지 않았다 — 실제로 사람이 검수한 적이 없다).
 *    거기에 아무 이름이나 채워 넣는 순간, 구조화 데이터로 거짓을 말하는 사이트가 된다.
 *    그건 이 작업이 막으려는 바로 그 문제다.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/supabase', () => ({ getSupabase: vi.fn() }));
// 상세 페이지는 관리자 조회수 칩(클라이언트)을 품는다 — SessionProvider 없이 렌더하려면 스텁이 필요하다.
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null, status: 'unauthenticated' }) }));
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: <T,>(fn: T) => fn,
}));

import { getSupabase } from '@/lib/supabase';

interface Row {
  slug: string; title: string; date: string; status: string;
  description?: string; tags?: string[]; content?: string;
  approved_by?: string | null; approved_at?: string | null;
}

/** 승인 기록이 있는 글 1편 + 관문 이전(기록 없음) 글 1편. */
const ROWS: Row[] = [
  {
    slug: 'reviewed-post', title: '검수된 글', date: '2026-09-05', status: 'published',
    description: '요약', tags: ['AI'],
    content: '<h2>소제목</h2><p>본문 문단.</p>',
    // KST 로 2026-09-06 15:20 — UTC 로 저장돼 있으므로 화면은 KST 로 읽어야 같은 날이 된다.
    approved_by: '관리자김', approved_at: '2026-09-06T06:20:00.000Z',
  },
  {
    slug: 'legacy-post', title: '관문 이전 글', date: '2026-05-01', status: 'published',
    description: '요약', tags: ['AI'],
    content: '<h2>소제목</h2><p>본문 문단.</p>',
    approved_by: null, approved_at: null,
  },
];

/** eq 필터를 실제로 적용하는 최소 대역 — 필터를 안 걸면 이 테스트가 경계를 못 본다. */
function makeDb(rows: Row[]) {
  return {
    from() {
      const filters: Record<string, unknown> = {};
      const match = () => rows.filter((r) =>
        Object.entries(filters).every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v));
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (k: string, v: unknown) => { filters[k] = v; return builder; },
        or: () => builder, like: () => builder, gte: () => builder,
        limit: () => builder, order: () => builder,
        maybeSingle: async () => ({ data: match()[0] ?? null, error: null }),
        single: async () => ({ data: match()[0] ?? null, error: null }),
        then: (ok: (v: unknown) => unknown, no: (e: unknown) => unknown) =>
          Promise.resolve({ data: match(), error: null }).then(ok, no),
      };
      return builder;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (getSupabase as unknown as ReturnType<typeof vi.fn>).mockReturnValue(makeDb(ROWS));
});

/** 상세 페이지를 그리고, 화면과 JSON-LD 를 함께 돌려준다. */
async function renderPost(slug: string) {
  const Page = (await import('@/app/(site)/blog/[slug]/page')).default;
  const { container } = render(await Page({ params: Promise.resolve({ slug }) }));
  const ld = [...container.querySelectorAll('script[type="application/ld+json"]')]
    .map((s) => JSON.parse(s.textContent ?? '{}') as Record<string, unknown>);
  return { container, blogPosting: ld.find((o) => o['@type'] === 'BlogPosting')! };
}

describe('검수 기록이 있는 글 — 사람과 기계 둘 다에게 밝힌다', () => {
  it('화면에 검수자와 검수일이 뜬다(검수일은 KST 기준)', async () => {
    await renderPost('reviewed-post');
    expect(screen.getByText(/검수: 관리자김/)).toBeInTheDocument();
    // 2026-09-06T06:20Z = KST 2026-09-06 15:20. UTC 로 읽으면 같은 날이지만, 경계 시각에
    // 하루가 어긋나는 것을 막으려고 timeZone 을 명시했다 — 그 표기를 고정한다.
    expect(screen.getByText(/2026년 9월 6일/)).toBeInTheDocument();
  });

  it('JSON-LD 에 reviewedBy 와 검수 시각(dateModified)이 들어간다', async () => {
    const { blogPosting } = await renderPost('reviewed-post');
    expect(blogPosting.reviewedBy).toEqual({ '@type': 'Person', name: '관리자김' });
    expect(blogPosting.dateModified).toBe('2026-09-06T06:20:00.000Z');
    // schema.org 에서 reviewedBy·lastReviewed 의 정의역은 WebPage 다 — 그쪽에도 실린다.
    const page = blogPosting.mainEntityOfPage as Record<string, unknown>;
    expect(page.lastReviewed).toBe('2026-09-06T06:20:00.000Z');
    expect(page.reviewedBy).toEqual({ '@type': 'Person', name: '관리자김' });
  });
});

describe('승인 기록이 없는 글 — 검수자를 지어내지 않는다', () => {
  it('화면에 검수 줄 자체가 없다', async () => {
    await renderPost('legacy-post');
    expect(screen.queryByText(/검수:/)).not.toBeInTheDocument();
    // 값이 비었을 때 'null'·'undefined' 를 그대로 그리는 구현으로 되돌아가면 여기서 깨진다.
    expect(screen.queryByText(/검수: (null|undefined|)/)).not.toBeInTheDocument();
  });

  it('JSON-LD 에 reviewedBy 가 없고 dateModified 는 발행일이다', async () => {
    const { blogPosting } = await renderPost('legacy-post');
    expect(blogPosting.reviewedBy).toBeUndefined();
    expect(blogPosting.dateModified).toBe('2026-05-01T00:00:00+09:00');
    expect(blogPosting.dateModified).toBe(blogPosting.datePublished);
    expect(blogPosting.mainEntityOfPage).not.toHaveProperty('reviewedBy');
    expect(blogPosting.mainEntityOfPage).not.toHaveProperty('lastReviewed');
  });

  it('검수자가 없어도 편집 정책으로 가는 길은 남는다', async () => {
    const { container } = await renderPost('legacy-post');
    // 검수자를 못 밝히는 이유까지 정책 페이지가 설명한다 — 여기서 링크를 감추면 설명이 사라진다.
    expect(container.querySelector('a[href="/editorial-policy"]')).not.toBeNull();
  });
});
