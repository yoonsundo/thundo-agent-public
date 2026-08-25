/**
 * cardnews-server — server/cardnews.ts 가 **실제로 조립하는 쿼리**를 본다.
 *
 * 소스에 `.eq('status','published')` 라는 문자열이 있는지가 아니라, 호출이 끝났을 때
 * 필터 집합이 무엇인지를 단언한다. 뒤에 다른 필터가 붙어 경계가 뚫려도 문자열 검사는
 * 못 잡지만 이건 잡는다.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase', () => ({ getSupabase: vi.fn() }));

import { getSupabase } from '@/lib/supabase';
import {
  getActiveCardnews, getAdminCardnews, markCardnewsPublished, unpublishCardnews,
} from '@/server/cardnews';

interface Recorded {
  table: string;
  filters: Record<string, unknown>;
  /** neq('status','published') 처럼 "이것만 빼고" 형태의 필터. */
  excludes: Record<string, unknown>;
  update: Record<string, unknown> | null;
  selects: string[];
  limit: number | null;
  order: string[];
}

/**
 * Supabase 쿼리 빌더 대역 — 체이닝을 기록하고 마지막에 주어진 결과를 돌려준다(thenable).
 * `from()` 한 번이 질의 하나다. 관리자 조회는 ready·published 를 따로 묻기 때문에
 * 기록을 배열로 모은다.
 */
function fakeDb(result: { data?: unknown; error?: unknown }) {
  const queries: Recorded[] = [];
  const db = {
    from(t: string) {
      const rec: Recorded = {
        table: t, filters: {}, excludes: {}, update: null, selects: [], limit: null, order: [],
      };
      queries.push(rec);
      const builder: Record<string, unknown> = {
        select: (c?: string) => { rec.selects.push(c ?? '*'); return builder; },
        eq: (k: string, v: unknown) => { rec.filters[k] = v; return builder; },
        neq: (k: string, v: unknown) => { rec.excludes[k] = v; return builder; },
        order: (c: string) => { rec.order.push(c); return builder; },
        limit: (n: number) => { rec.limit = n; return builder; },
        update: (patch: Record<string, unknown>) => { rec.update = patch; return builder; },
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
          Promise.resolve(result).then(res, rej),
      };
      return builder;
    },
  };
  (getSupabase as unknown as ReturnType<typeof vi.fn>).mockReturnValue(db);
  return queries;
}

/** 질의가 하나뿐인 호출용(공개 조회·발행 전환). */
const only = (queries: Recorded[]): Recorded => {
  if (queries.length !== 1) throw new Error(`질의가 ${queries.length}개다`);
  return queries[0];
};

const ROW = { post_id: 'cn-1', subject: 's', slide_urls: ['https://cdn/1.jpg'], status: 'published' };

beforeEach(() => vi.clearAllMocks());

describe('공개 조회', () => {
  it('필터 집합이 정확히 {active, status} 다 — 하나라도 빠지면 미게시분이 샌다', async () => {
    const q = fakeDb({ data: [ROW], error: null });
    await getActiveCardnews();
    expect(only(q).filters).toEqual({ active: true, status: 'published' });
    expect(only(q).table).toBe('cardnews_posts');
  });

  it('bgm_suggestions 형식이상을 방어한다 — title·artist 없는 항목은 버린다', async () => {
    fakeDb({
      data: [{
        ...ROW,
        bgm_suggestions: [
          { title: 'River Flows in You', artist: 'Yiruma', mood: '잔잔' },
          { title: '', artist: 'X' },          // title 없음 → 버림
          { junk: true },                       // 형식이상 → 버림
          'not-an-object',                      // 비객체 → 버림
        ],
      }],
      error: null,
    });
    const [row] = await getActiveCardnews();
    expect(row.bgm_suggestions).toEqual([{ title: 'River Flows in You', artist: 'Yiruma', mood: '잔잔' }]);
  });

  it('오류면 빈 배열 — 페이지는 빈 상태를 렌더하고 죽지 않는다', async () => {
    fakeDb({ data: null, error: { message: 'boom' } });
    expect(await getActiveCardnews()).toEqual([]);
  });
});

describe('관리자 조회', () => {
  it('active 로 거르지 않는다 — 숨긴 것도 관리자는 봐야 되돌린다', async () => {
    const q = fakeDb({ data: [ROW], error: null });
    await getAdminCardnews();
    for (const rec of q) expect(rec.filters.active).toBeUndefined();
  });

  it('🔴 발행대기에는 상한이 없다 — 상한을 걸면 밀린 대기분이 조용히 사라진다', async () => {
    const q = fakeDb({ data: [], error: null });
    await getAdminCardnews();
    const ready = q.find((r) => r.excludes.status === 'published');
    expect(ready, 'ready 를 따로 묻는 질의가 있어야 한다').toBeDefined();
    expect(ready!.limit, '발행대기는 전량 가져온다').toBeNull();
  });

  it('발행됨에는 상한이 있다 — 캡션·슬라이드 전문이라 무한정 자라면 무거워진다', async () => {
    const q = fakeDb({ data: [], error: null });
    await getAdminCardnews();
    const published = q.find((r) => r.filters.status === 'published');
    expect(published, 'published 를 따로 묻는 질의가 있어야 한다').toBeDefined();
    expect(published!.limit).toBeGreaterThan(0);
  });
});

describe('발행 전환', () => {
  it('published 로 바꾸고 permalink·공개를 함께 쓴다', async () => {
    const q = fakeDb({ data: [{ post_id: 'cn-1' }], error: null });
    const r = await markCardnewsPublished('cn-1', 'https://www.instagram.com/p/CxyzAbc123/');
    expect(r.ok).toBe(true);
    expect(only(q).update).toMatchObject({
      status: 'published', active: true, permalink: 'https://www.instagram.com/p/CxyzAbc123/',
    });
    expect(only(q).filters).toEqual({ post_id: 'cn-1' });
  });

  it('갱신된 행이 없으면 실패다 — 없는 id 로 "발행 완료"가 뜨면 안 된다', async () => {
    fakeDb({ data: [], error: null });
    const r = await markCardnewsPublished('없는-id', 'https://www.instagram.com/p/CxyzAbc123/');
    expect(r.ok).toBe(false);
  });

  it('형식이 아닌 링크는 DB 에 닿지도 않는다', async () => {
    fakeDb({ data: [{ post_id: 'cn-1' }], error: null });
    const r = await markCardnewsPublished('cn-1', 'https://example.com/x');
    expect(r.ok).toBe(false);
    expect(getSupabase).not.toHaveBeenCalled();
  });

  it('발행 취소는 permalink 를 지우고 다시 감춘다', async () => {
    const q = fakeDb({ data: [{ post_id: 'cn-1' }], error: null });
    const r = await unpublishCardnews('cn-1');
    expect(r.ok).toBe(true);
    expect(only(q).update).toEqual({ status: 'ready', active: false, permalink: null });
  });

  it('취소도 없는 id 면 실패다', async () => {
    fakeDb({ data: [], error: null });
    expect((await unpublishCardnews('없는-id')).ok).toBe(false);
  });
});
