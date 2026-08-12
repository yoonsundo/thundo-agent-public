/**
 * server/cardnews.ts — 인스타 카드뉴스 발행물 서버 유틸 (서버 전용, videos.ts 패턴 미러)
 *
 * - getActiveCardnews(): 공개 /cardnews 페이지용. active=true 만 published_at desc 순.
 *   테이블 없음/오류 시 빈 배열 → 페이지는 빈 상태 안내를 렌더(죽지 않음).
 *
 * 환경변수: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (서버에서만 사용)
 */
import { getSupabase } from '@/lib/supabase';

export interface CardnewsRow {
  post_id:      string;
  subject:      string;
  problem:      string;
  book:         string;
  author:       string;
  /** 표지 이미지. cover_url 이 비면 슬라이드 첫 장으로 대체하고, 그것도 없으면 null. */
  cover_url:    string | null;
  slide_urls:   string[];
  /** 인스타 퍼머링크. Graph API 가 준 값만 담는다 — media_id 로 URL 을 만들어내지 않는다. */
  permalink:    string | null;
  published_at: string | null;
  active:       boolean;
}

/** jsonb 컬럼 → 문자열 배열(형식이상 방어). */
function toUrlList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((u): u is string => typeof u === 'string' && u.length > 0);
}

/** DB row → CardnewsRow 정규화(부분/형식이상 방어). */
function normalize(r: Record<string, unknown>): CardnewsRow {
  const slides = toUrlList(r.slide_urls);
  const cover = r.cover_url ? String(r.cover_url) : slides[0] ?? null;
  return {
    post_id:      String(r.post_id ?? ''),
    subject:      String(r.subject ?? ''),
    problem:      String(r.problem ?? ''),
    book:         String(r.book ?? ''),
    author:       String(r.author ?? ''),
    cover_url:    cover,
    slide_urls:   slides,
    permalink:    r.permalink ? String(r.permalink) : null,
    published_at: r.published_at ? String(r.published_at) : null,
    active:       r.active !== false,
  };
}

/** getActiveCardnews() — 공개 페이지용. 오류 시 빈 배열(폴백, UI가 빈 상태 렌더). */
export async function getActiveCardnews(): Promise<CardnewsRow[]> {
  const db = getSupabase();
  if (!db) return [];
  try {
    const { data, error } = await db
      .from('cardnews_posts')
      .select('*')
      .eq('active', true)
      .order('published_at', { ascending: false });
    if (error || !Array.isArray(data)) return [];
    return data.map(normalize);
  } catch {
    return [];
  }
}
