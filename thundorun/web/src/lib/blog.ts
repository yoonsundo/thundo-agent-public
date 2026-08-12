/**
 * lib/blog.ts — 서버 전용 블로그 로더 (Supabase DB)
 * blog_posts 테이블: slug(PK), title, date, status, description, tags(jsonb), content
 * service_role RLS — getSupabase() 사용.
 * getAllPosts() / getPost() 는 async 함수.
 */
import { getSupabase } from '@/lib/supabase';

export interface Post {
  slug:         string;
  title:        string;
  date:         string;       // YYYY-MM-DD
  description?: string;
  tags?:        string[];
  status:       string;
  content:      string;       // 발행 시 mdToHtml 로 변환된 시맨틱 HTML (render-fit 게이트 통과분)
}

/** 발행 글 전체 목록 (date 내림차순). Supabase 미연결 시 빈 배열. */
export async function getAllPosts(): Promise<Post[]> {
  const db = getSupabase();
  if (!db) return [];

  const { data, error } = await db
    .from('blog_posts')
    .select('slug, title, date, status, description, tags, content')
    .eq('status', 'published')
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
    .eq('status', 'published')
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
    .eq('status', 'published')
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

/** 단일 글 조회 (status 무관 — 상세 페이지는 published 만). */
export async function getPost(slug: string): Promise<Post | null> {
  const db = getSupabase();
  if (!db) return null;

  const { data, error } = await db
    .from('blog_posts')
    .select('slug, title, date, status, description, tags, content')
    .eq('slug', slug)
    .eq('status', 'published')
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
  };
}
