/**
 * server/videos.ts — 유튜브 영상 소개 서버 유틸 (서버 전용, agents.ts 패턴 미러)
 *
 * - getActiveVideos(): 공개 /videos 페이지용. active=true 만 published_at desc 순.
 *   테이블 없음/오류 시 빈 배열 → 페이지는 빈 상태 안내를 렌더(죽지 않음).
 *
 * 환경변수: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (서버에서만 사용)
 */
import { getSupabase } from '@/lib/supabase';

export interface VideoRow {
  youtube_id:    string;
  title:         string;
  subject:       string;
  domain:        string;
  youtube_url:   string;
  thumbnail_url: string | null;
  published_at:  string | null;
  active:        boolean;
}

/** DB row → VideoRow 정규화(부분/형식이상 방어). */
function normalize(r: Record<string, unknown>): VideoRow {
  return {
    youtube_id:    String(r.youtube_id ?? ''),
    title:         String(r.title ?? ''),
    subject:       String(r.subject ?? ''),
    domain:        String(r.domain ?? ''),
    youtube_url:   String(r.youtube_url ?? ''),
    thumbnail_url: r.thumbnail_url ? String(r.thumbnail_url) : null,
    published_at:  r.published_at ? String(r.published_at) : null,
    active:        r.active !== false,
  };
}

/** getActiveVideos() — 공개 페이지용. 오류 시 빈 배열(폴백, UI가 빈 상태 렌더). */
export async function getActiveVideos(): Promise<VideoRow[]> {
  const db = getSupabase();
  if (!db) return [];
  try {
    const { data, error } = await db
      .from('youtube_videos')
      .select('*')
      .eq('active', true)
      .order('published_at', { ascending: false });
    if (error || !Array.isArray(data)) return [];
    return data.map(normalize);
  } catch {
    return [];
  }
}
