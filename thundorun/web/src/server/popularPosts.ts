/**
 * server/popularPosts.ts — 조회수 기준 인기 블로그 Top N (서버 전용).
 *
 * blog_posts 테이블엔 조회수 칼럼이 없다. 조회수는 traffic_pv(date,hour,path,views)에
 * 경로별로 집계돼 있으므로 '/blog/<slug>' 경로만 모아 slug별로 합산해 상위 N을 뽑는다.
 * (PV 는 미들웨어가 서버사이드로 원자 증분 — 광고차단 영향 없음.)
 *
 * 스키마 변경/RPC 불필요: 최근 WINDOW_DAYS 구간의 /blog/* 행만 읽어 JS 에서 합산.
 * Supabase 미연결·데이터 없음 시 빈 배열 → 컴포넌트가 빈 상태 메시지를 표시. (getProjects 폴백 패턴 동일.)
 *
 * 제목·날짜 매핑용 발행글 목록은 호출측(page.tsx)이 이미 읽은 걸 넘겨받아 중복 조회를 피한다.
 */
import { getSupabase } from '@/lib/supabase';
import type { PostSummary } from '@/lib/blog';
import type { PopularPost } from '@/components/ProjectsDashboard';

const WINDOW_DAYS = 90;    // '인기글' 집계 구간(행 수 상한 + 최신성 반영)
const MAX_ROWS    = 10000; // 방어적 상한(구간·경로 필터로 실제론 훨씬 적음)

/** 오늘로부터 days 이전 날짜(YYYY-MM-DD, UTC — traffic_pv.date 와 동일 기준). */
function fromDateISO(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * fetchPopularSlugViews() — traffic_pv 만 읽어 slug별 조회수 합산(내림차순) 반환.
 * posts 에 의존하지 않으므로 홈에서 프로필·목록 조회와 '병렬'로 시작할 수 있다
 * (기존엔 목록 조회 후 순차 실행 → DB 왕복 1회 추가). 제목·날짜 매핑은 joinPopularPosts 로 분리.
 */
export async function fetchPopularSlugViews(): Promise<Array<[string, number]>> {
  const db = getSupabase();
  if (!db) return [];
  try {
    // MAX_ROWS 상한에 걸릴 경우 최신 데이터부터 남도록 date 내림차순 정렬(결정적 절단).
    const { data, error } = await db
      .from('traffic_pv')
      .select('path, views')
      .like('path', '/blog/%')
      .gte('date', fromDateISO(WINDOW_DAYS))
      .order('date', { ascending: false })
      .limit(MAX_ROWS);
    if (error || !Array.isArray(data) || data.length === 0) return [];

    // slug별 조회수 합산 ('/blog/<slug>' 단일 세그먼트만 인정 — 하위 경로/목록 제외).
    const views = new Map<string, number>();
    for (const row of data) {
      const path = String((row as { path?: unknown }).path ?? '');
      const slug = path.replace(/^\/blog\//, '').replace(/\/$/, '');
      if (!slug || slug.includes('/')) continue;
      const v = Number((row as { views?: unknown }).views ?? 0);
      views.set(slug, (views.get(slug) ?? 0) + (Number.isFinite(v) ? v : 0));
    }
    return [...views.entries()].sort((a, b) => b[1] - a[1]);
  } catch {
    return [];
  }
}

/** joinPopularPosts() — 집계된 [slug,views] 에 발행글 메타를 붙여 상위 limit 개. DB 접근 없음(순수). */
export function joinPopularPosts(
  slugViews: Array<[string, number]>,
  posts: PostSummary[],
  limit = 5,
): PopularPost[] {
  // 발행된 글만 제목·날짜 매핑(미발행·삭제된 slug 는 제외). slugViews 는 이미 views 내림차순.
  const meta = new Map(posts.map((p) => [p.slug, p]));
  return slugViews
    .filter(([slug]) => meta.has(slug))
    .slice(0, limit)
    .map(([slug, v]) => {
      const p = meta.get(slug)!;
      return { slug, title: p.title, date: p.date, views: v };
    });
}

/**
 * toPublicPopularPosts() — 홈 ISR 페이로드에 실을 **공개 형태**(조회수 제거). 순수함수.
 *
 * 🔴 홈은 ISR(revalidate=300) 이라 캐시된 HTML·RSC 를 전 방문자가 공유한다. 조회수를 담아
 *    보내면 소스 보기 한 번에 노출되므로, 페이지가 아니라 **여기서** 형태로 잘라낸다.
 *    페이지 안에서 인라인 map 으로 처리하면 "투영이 있는가"만 검사하는 소스 가드를
 *    항등 map(`.map((p) => p)`)이나 스프레드(`{...p, rank}`)가 통과해 조용히 다시 샌다
 *    (2026-08-07 리뷰에서 실증됨). 이름 있는 함수로 뽑아야 **동작으로** 잠글 수 있다.
 *
 * 순위는 호출측이 이미 조회수로 정렬해 넘기므로 숫자가 없어도 유지된다.
 */
export function toPublicPopularPosts(rows: PopularPost[]): Omit<PopularPost, 'views'>[] {
  return rows.map((p) => ({ slug: p.slug, title: p.title, date: p.date }));
}

/** getPopularPosts() — 최근 구간 /blog/* PV 를 slug별 합산 → 조회수 상위 limit 개. */
export async function getPopularPosts(posts: PostSummary[], limit = 5): Promise<PopularPost[]> {
  return joinPopularPosts(await fetchPopularSlugViews(), posts, limit);
}
