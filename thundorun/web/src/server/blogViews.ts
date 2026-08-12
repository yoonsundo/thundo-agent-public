/**
 * server/blogViews.ts — 블로그 글별 조회수(총 PV) 조회 (서버 전용).
 *
 * blog_posts 엔 조회수 칼럼이 없다. 조회수는 traffic_pv(date,hour,path,views)에
 * 경로별로 집계돼 있으므로 '/blog/<slug>' PV 를 slug별로 합산한다.
 * Supabase 미연결·오류 시 빈 결과로 안전 폴백. (getPopularPosts 와 동일 패턴, 여긴 전체 기간 누적.)
 */
import { getSupabase } from '@/lib/supabase';

const MAX_ROWS = 20000; // 방어적 상한(/blog/* 경로만 → 실제론 훨씬 적음)

/** slug → 총 조회수 맵. 전체 /blog/* PV 를 slug별 합산. */
export async function getBlogViewMap(): Promise<Record<string, number>> {
  const db = getSupabase();
  if (!db) return {};
  try {
    const { data, error } = await db
      .from('traffic_pv')
      .select('path, views')
      .like('path', '/blog/%')
      .limit(MAX_ROWS);
    if (error || !Array.isArray(data)) return {};
    const map: Record<string, number> = {};
    for (const row of data) {
      const path = String((row as { path?: unknown }).path ?? '');
      const slug = path.replace(/^\/blog\//, '').replace(/\/$/, '');
      if (!slug || slug.includes('/')) continue; // '/blog/<slug>' 단일 세그먼트만
      const v = Number((row as { views?: unknown }).views ?? 0);
      map[slug] = (map[slug] ?? 0) + (Number.isFinite(v) ? v : 0);
    }
    return map;
  } catch {
    return {};
  }
}

/** 단일 글의 총 조회수. */
export async function getBlogViews(slug: string): Promise<number> {
  const db = getSupabase();
  if (!db || !slug) return 0;
  try {
    const { data, error } = await db
      .from('traffic_pv')
      .select('views')
      .eq('path', `/blog/${slug}`)
      .limit(5000);
    if (error || !Array.isArray(data)) return 0;
    return data.reduce((s, r) => s + (Number((r as { views?: unknown }).views ?? 0) || 0), 0);
  } catch {
    return 0;
  }
}
