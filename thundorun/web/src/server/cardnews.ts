/**
 * server/cardnews.ts — 인스타 카드뉴스 발행물 서버 유틸 (서버 전용, videos.ts 패턴 미러)
 *
 * - getActiveCardnews():  공개 /cardnews 페이지용. **status='published' + active=true** 만.
 * - getAdminCardnews():   /admin/cardnews 용. ready·published 를 모두 준다(캡션 포함).
 *
 * ⚠ 2026-08-21 반자동 발행으로 전환했다. 음악을 넣을 수 없어 완전 자동 발행을 포기하고,
 *   파이프라인은 제작·호스팅까지만 한다. 관리자가 인스타에 직접 올린 뒤 공개로 바꾼다.
 *   그래서 **status 가 공개 경계**다 — 이 필터를 빼면 미게시분이 사이트에 노출된다.
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
  /** ready=인스타 미게시(관리자만) · published=관리자가 올림(공개). active 는 발행 뒤 숨김 스위치. */
  status:       'ready' | 'published';
  /** 인스타 캡션 원문 — 관리자 화면이 복사해 쓴다. 공개 페이지는 쓰지 않는다. */
  caption:      string | null;
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
    // 컬럼이 없던 시절 행/형식이상은 'published' 로 본다 — 구 자동발행 경로로 들어온 것이라
    // 'ready' 로 떨어뜨리면 이미 공개돼 있던 글이 사라진다.
    status:       r.status === 'ready' ? 'ready' : 'published',
    caption:      r.caption ? String(r.caption) : null,
    active:       r.active !== false,
  };
}

/**
 * 관리자 화면용 — ready(발행대기)와 published(발행됨)를 모두 준다.
 * 공개 함수와 달리 `active` 로 거르지 않는다: 숨긴 건도 관리자는 봐야 되돌릴 수 있다.
 * 정렬은 created_at desc — ready 는 published_at 이 아직 의미가 없다(기본값 now()가 들어 있다).
 */
export async function getAdminCardnews(): Promise<CardnewsRow[]> {
  const db = getSupabase();
  if (!db) return [];
  try {
    const { data, error } = await db
      .from('cardnews_posts')
      .select('*')
      .order('created_at', { ascending: false });
    if (error || !Array.isArray(data)) return [];
    return data.map(normalize);
  } catch {
    return [];
  }
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
      // ⚠ status 필터가 이 화면의 공개 경계다. 관리자가 인스타에 올리기 전(ready)에는
      //   일반 사용자에게 보이지 않는다(2026-08-21 반자동 발행 전환).
      .eq('status', 'published')
      .order('published_at', { ascending: false });
    if (error || !Array.isArray(data)) return [];
    return data.map(normalize);
  } catch {
    return [];
  }
}

/**
 * 인스타 퍼머링크 형식 검사.
 *
 * ⚠ 느슨하게 받으면 안 된다 — 갤러리의 "인스타에서 보기" 링크가 여기서 나오고,
 *   오타가 들어가면 그럴듯하지만 열리지 않는 링크가 영구히 박힌다(이 파일이 애초에
 *   "media_id 로 URL 을 조립하지 않는다"고 못박은 이유와 같다).
 * 허용: https://www.instagram.com/p/<code>/ · /reel/<code>/ · /tv/<code>/ (쿼리·끝 슬래시 허용)
 */
export function isInstagramPermalink(v: string): boolean {
  return /^https:\/\/(www\.)?instagram\.com\/(p|reel|tv)\/[A-Za-z0-9_-]{5,}\/?(\?.*)?$/.test(v.trim());
}

export interface PublishResult { ok: boolean; error?: string }

/**
 * 관리자가 인스타에 올린 뒤 "발행 완료"를 누르면 호출된다 — **여기서 공개로 바뀐다.**
 * permalink 는 사람이 붙여넣는 값이라 형식을 강제한다. media_id 는 건드리지 않는다
 * (Graph API 가 준 값만 담는다는 이 모듈의 계약).
 */
export async function markCardnewsPublished(postId: string, permalink: string): Promise<PublishResult> {
  const link = permalink.trim();
  if (!postId) return { ok: false, error: 'post_id 가 없다' };
  if (!isInstagramPermalink(link)) {
    return { ok: false, error: '인스타그램 게시물 링크 형식이 아니다 (예: https://www.instagram.com/p/XXXXXXXXXXX/)' };
  }
  const db = getSupabase();
  if (!db) return { ok: false, error: 'DB 연결 없음' };
  const { error } = await db
    .from('cardnews_posts')
    .update({ status: 'published', active: true, permalink: link, published_at: new Date().toISOString() })
    .eq('post_id', postId);
  return error ? { ok: false, error: error.message } : { ok: true };
}

/**
 * 발행 취소 — 실수로 공개한 건을 다시 감춘다.
 * permalink 는 **지운다**. 인스타에서 실제로 내렸을 수도 있는데 링크만 남으면 죽은 링크가 된다.
 */
export async function unpublishCardnews(postId: string): Promise<PublishResult> {
  if (!postId) return { ok: false, error: 'post_id 가 없다' };
  const db = getSupabase();
  if (!db) return { ok: false, error: 'DB 연결 없음' };
  const { error } = await db
    .from('cardnews_posts')
    .update({ status: 'ready', active: false, permalink: null })
    .eq('post_id', postId);
  return error ? { ok: false, error: error.message } : { ok: true };
}
