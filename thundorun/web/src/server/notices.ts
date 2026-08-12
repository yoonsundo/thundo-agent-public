/**
 * server/notices.ts — 공지사항 서버 유틸 (서버 전용, service_role)
 *
 * - getPinnedNotices(): 공개용 — pinned=true 만, pinned_at desc, 최대 5건.
 * - getAllNotices(): 관리자용 — 전체 목록, pinned 우선(pinned_at desc) → created_at desc.
 *
 * Next.js request 객체를 모른다(blogViews.ts/siteProfile.ts와 동일 원칙).
 */
import { getSupabase } from '@/lib/supabase';

export interface Notice {
  id:         string;
  title:      string;
  body:       string;
  pinned:     boolean;
  pinned_at:  string | null;
  author:     string | null;
  created_at: string;
  updated_at: string;
}

const NOTICE_COLUMNS = 'id, title, body, pinned, pinned_at, author, created_at, updated_at';

/** 공개 배너·목록용 — 고정 공지만, pinned_at desc, 최대 5건. 실패 시 빈 배열로 안전 폴백. */
export async function getPinnedNotices(): Promise<Notice[]> {
  const db = getSupabase();
  if (!db) return [];
  try {
    const { data, error } = await db
      .from('notices')
      .select(NOTICE_COLUMNS)
      .eq('pinned', true)
      .order('pinned_at', { ascending: false })
      .limit(5);
    if (error || !Array.isArray(data)) return [];
    return data as Notice[];
  } catch {
    return [];
  }
}

/** 관리자 전용 — 전체 목록. 고정(pinned_at desc) 우선 → 나머지 created_at desc. */
export async function getAllNotices(): Promise<Notice[]> {
  const db = getSupabase();
  if (!db) return [];
  try {
    const { data, error } = await db
      .from('notices')
      .select(NOTICE_COLUMNS)
      .order('pinned', { ascending: false })
      .order('pinned_at', { ascending: false })
      .order('created_at', { ascending: false });
    if (error || !Array.isArray(data)) return [];
    return data as Notice[];
  } catch {
    return [];
  }
}
