/**
 * lib/blog.ts — 서버 전용 블로그 로더 (Supabase DB)
 * blog_posts 테이블: slug(PK), title, date, status, description, tags(jsonb), content
 * service_role RLS — getSupabase() 사용.
 * getAllPosts() / getPost() 는 async 함수.
 *
 * 🔴 이 파일의 모든 조회는 status=PUBLIC_STATUS('published') 로 거른다 — 사람이 승인하지
 *    않은 글(ready)이 목록·상세·RSS·llms.txt 어디에도 새지 않게 하는 경계다(2026-09-07).
 */
import { unstable_cache } from 'next/cache';
import { getSupabase } from '@/lib/supabase';
import { PUBLIC_STATUS } from '@/lib/blog-status';

/**
 * 블로그 데이터 캐시 태그. 승인·발행·삭제 API 가 `revalidateTag(BLOG_CACHE_TAG)` 로 버린다.
 * 태그 문자열을 두 곳에 복제하면 한쪽만 고쳐져 캐시가 영영 안 버려지므로 상수로 잠근다.
 */
export const BLOG_CACHE_TAG = 'blog-posts';

/** 목록 캐시 수명(초). 홈 ISR(revalidate=300)과 같은 값 — 화면마다 신선도가 다르면 설명이 안 된다. */
export const BLOG_CACHE_TTL = 300;

export interface Post {
  slug:         string;
  title:        string;
  date:         string;       // YYYY-MM-DD
  description?: string;
  tags?:        string[];
  status:       string;
  content:      string;       // 발행 시 mdToHtml 로 변환된 시맨틱 HTML (render-fit 게이트 통과분)
  /**
   * 사람 검수 기록. **없으면 null 이다 — 빈 문자열이나 '알 수 없음' 으로 채우지 않는다.**
   * 승인 관문(2026-09-07) 이전에 자동 발행된 207편은 실제로 검수자가 없어 null 이고,
   * 화면·JSON-LD 는 값이 있을 때만 검수자를 말한다("검수자 없음"과 "기록 이전"의 구분).
   */
  approvedBy?:  string | null;
  approvedAt?:  string | null;  // ISO timestamptz
}

/** 발행 글 전체 목록 (date 내림차순). Supabase 미연결 시 빈 배열. */
export async function getAllPosts(): Promise<Post[]> {
  const db = getSupabase();
  if (!db) return [];

  const { data, error } = await db
    .from('blog_posts')
    .select('slug, title, date, status, description, tags, content')
    .eq('status', PUBLIC_STATUS)
    .order('date', { ascending: false });

  if (error || !data) return [];

  return data.map((row) => ({
    slug:        String(row.slug  ?? ''),
    title:       String(row.title ?? row.slug ?? ''),
    date:        String(row.date  ?? '').slice(0, 10),
    description: row.description ? String(row.description) : undefined,
    tags:        Array.isArray(row.tags) ? (row.tags as string[]) : [],
    status:      String(row.status ?? 'published'),
    content:     String(row.content ?? ''),
  }));
}

/** 관련글·인접글 계산용 경량 메타(본문 제외). */
export type PostSummary = Pick<Post, 'slug' | 'title' | 'date' | 'description' | 'tags'>;

/**
 * 발행글 메타만(content 제외) date 내림차순.
 * 관련글·이전다음 내비 계산용 경량 로더 — force-dynamic + no-store 라 content 를
 * 빼서 왕복 페이로드를 줄인다. (본문이 필요한 목록/상세는 getAllPosts/getPost 사용.)
 */
export async function getPostSummaries(): Promise<PostSummary[]> {
  const db = getSupabase();
  if (!db) return [];

  const { data, error } = await db
    .from('blog_posts')
    .select('slug, title, date, status, description, tags')   // content 제외
    .eq('status', PUBLIC_STATUS)
    .order('date', { ascending: false });

  if (error || !data) return [];

  return data.map((row) => ({
    slug:        String(row.slug  ?? ''),
    title:       String(row.title ?? row.slug ?? ''),
    date:        String(row.date  ?? '').slice(0, 10),
    description: row.description ? String(row.description) : undefined,
    tags:        Array.isArray(row.tags) ? (row.tags as string[]) : [],
  }));
}

/**
 * getCachedPostSummaries() — getPostSummaries 를 Next 데이터 캐시에 태그와 함께 담은 것.
 *
 * 왜 필요한가: `/blog` 목록은 ISR 로 만들 수 없다. `searchParams`(tag·q·page)를 서버에서
 * 읽는 순간 그 라우트는 요청마다 동적으로 렌더된다 — 캐시된 HTML 하나로 `?tag=AI` 와
 * `?page=3` 을 동시에 만족시킬 수 없기 때문이다. 그래서 **HTML 이 아니라 데이터**를 캐시한다.
 * 207편 메타를 매 요청 DB 에서 새로 끌어오던 왕복이 사라진다(실측 TTFB 1.52s).
 *
 * 신선도 계약은 홈 ISR 과 같다 — 최대 BLOG_CACHE_TTL 초, 그전이라도 승인·발행·삭제 API 가
 * `revalidateTag(BLOG_CACHE_TAG)` 로 즉시 버린다. 승인 직후 목록에 안 뜨면 관문이 고장 난
 * 것처럼 보이므로 이 무효화가 캐시 도입의 전제다.
 */
export const getCachedPostSummaries = unstable_cache(
  getPostSummaries,
  ['blog-post-summaries'],
  { revalidate: BLOG_CACHE_TTL, tags: [BLOG_CACHE_TAG] },
);

/**
 * PostgREST or-필터 값 정리 — 쉼표·괄호는 필터 문법의 구분자라 값에 들어가면 쿼리가 깨진다.
 * 와일드카드는 `*`(PostgREST 관례). 순수함수라 DB 없이 테스트한다.
 * @returns 안전한 패턴 문자열. 검색할 내용이 없으면 null.
 */
export function toSearchPattern(query: string): string | null {
  const safe = String(query ?? '')
    // 쉼표·괄호·백슬래시는 or-필터 문법을 깨뜨린다 — 값에서 제거.
    .replace(/[,()\\]/g, ' ')
    .trim();
  if (!safe) return null;
  // `%` 와 `_` 는 ILIKE 의 와일드카드다. 그대로 두면 검색어가 아니라 패턴이 된다
  // (예: `ll_` 이 119건 매치 — 이전 JS .includes() 는 리터럴이었다). 이스케이프해 리터럴로.
  const literal = safe.replace(/[%_]/g, (ch) => `\\${ch}`);
  return `*${literal}*`;
}

/**
 * searchPostSlugs — 검색어에 걸리는 글의 slug 집합을 **DB 에서** 추린다.
 *
 * 왜 필요한가: 예전엔 목록 페이지가 `getAllPosts()` 로 전 글 본문을 앱까지 끌어와 JS 로
 * 필터링했다. 131편 기준 매 요청 4.44MB 였고 글 1편당 +34KB 씩 선형으로 무거워졌다.
 * 본문은 검색에만 쓰이므로 그 일은 DB 가 해야 한다 — 앱은 slug 만 받는다.
 *
 * @returns 매칭 slug 집합. 검색어가 없으면 null(= 필터 안 함).
 */
export async function searchPostSlugs(query: string): Promise<Set<string> | null> {
  const pattern = toSearchPattern(query);
  if (!pattern) return null;
  const db = getSupabase();
  if (!db) return new Set();

  const { data, error } = await db
    .from('blog_posts')
    .select('slug')                       // slug 만 — 본문은 DB 안에서만 훑는다
    .eq('status', PUBLIC_STATUS)
    .or(`title.ilike.${pattern},description.ilike.${pattern},content.ilike.${pattern}`);

  if (error || !data) return new Set();
  return new Set(data.map((row) => String(row.slug ?? '')));
}

/**
 * pickRelated — target 과 태그가 겹치는 정도(Jaccard)로 상위 limit 개를 고르는 순수 함수.
 * 1순위 태그 정합도, 2순위(동점) 최신글. 겹침이 0이거나 부족하면 최신글(자기 제외)로
 * 채워 항상 limit 개를 반환한다(빈 섹션 방지). DB 접근 없음 — 테스트 용이.
 */
export function pickRelated(
  target: PostSummary,
  all: PostSummary[],
  limit = 3,
): PostSummary[] {
  const t = new Set((target.tags ?? []).map((s) => s.toLowerCase()));
  const candidates = all.filter((p) => p.slug !== target.slug);

  const scored = candidates.map((p) => {
    const tags = new Set((p.tags ?? []).map((s) => s.toLowerCase()));
    let inter = 0;
    for (const tag of tags) if (t.has(tag)) inter++;
    const union = t.size + tags.size - inter;
    const jaccard = union === 0 ? 0 : inter / union;
    return { p, jaccard, date: p.date };
  });

  scored.sort((a, b) =>
    b.jaccard - a.jaccard ||          // 1순위: 태그 정합도
    b.date.localeCompare(a.date),     // 2순위(동점): 최신글
  );

  const related = scored.filter((s) => s.jaccard > 0).slice(0, limit).map((s) => s.p);

  // 겹침 0 또는 부족분은 최신글(자기 제외)로 채움 — 빈 섹션 방지.
  if (related.length < limit) {
    const have = new Set(related.map((p) => p.slug).concat(target.slug));
    for (const p of candidates) {
      if (related.length >= limit) break;
      if (!have.has(p.slug)) { related.push(p); have.add(p.slug); }
    }
  }
  return related;
}

/**
 * 단일 글 조회 — **published 만** 준다.
 * 승인 대기(ready)·초안(draft)은 slug 를 직접 쳐도 404 다. 관리자 검수는
 * /api/admin/blog?slug=… (관리 경로)로 본다 — 공개 경로와 관리 경로는 분리돼 있다.
 */
export async function getPost(slug: string): Promise<Post | null> {
  const db = getSupabase();
  if (!db) return null;

  const { data, error } = await db
    .from('blog_posts')
    .select('slug, title, date, status, description, tags, content, approved_by, approved_at')
    .eq('slug', slug)
    .eq('status', PUBLIC_STATUS)
    .maybeSingle();

  if (error || !data) return null;

  return {
    slug:        String(data.slug  ?? ''),
    title:       String(data.title ?? data.slug ?? ''),
    date:        String(data.date  ?? '').slice(0, 10),
    description: data.description ? String(data.description) : undefined,
    tags:        Array.isArray(data.tags) ? (data.tags as string[]) : [],
    status:      String(data.status ?? 'published'),
    content:     String(data.content ?? ''),
    // 없는 사실은 null 로 둔다 — `?? ''` 로 채우면 화면이 "검수: (빈칸)" 을 그리게 된다.
    approvedBy:  data.approved_by ? String(data.approved_by) : null,
    approvedAt:  data.approved_at ? String(data.approved_at) : null,
  };
}
