import { Suspense } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { getCachedPostSummaries, searchPostSlugs, type PostSummary } from '@/lib/blog';
import { getBlogViewMap } from '@/server/blogViews';
import { isAdminViewer } from '@/server/adminViewer';
import BlogSearch from '@/components/BlogSearch';
import Empty from '@/components/state/Empty';
import ErrorState from '@/components/state/ErrorState';
import { CardSkeleton } from '@/components/state/Skeleton';

/**
 * 🔴 이 페이지는 ISR 로 만들 수 없다 — 게으름이 아니라 구조다.
 *    목록은 `searchParams`(tag·q·page)를 서버에서 읽어 결과를 바꾼다. 캐시된 HTML 하나로
 *    `?tag=AI` 와 `?page=3` 을 동시에 만족시킬 수 없으므로 라우트는 요청마다 렌더돼야 한다.
 *    대신 **비싼 쪽(DB 왕복)을 캐시**한다 — getCachedPostSummaries(태그 무효화, lib/blog.ts).
 *    요청별 입력이 없는 글 상세(/blog/[slug])는 거기서 진짜 ISR 을 쓴다.
 *
 * ⚠ `export const dynamic = 'force-dynamic'` 를 뺐다. searchParams·세션 때문에 어차피 동적
 *    렌더인데, force-dynamic 이 붙어 있으면 데이터 캐시까지 함께 꺼져 위 캐시가 무의미해진다.
 */

export const metadata = {
  title: '블로그 — Thundo',
  description: 'AI 도구·자동화·생산성에 관한 글 모음.',
};

const PER_PAGE = 10;

/** 태그 필터 pill 클래스 — 선택된 태그면 강조, 아니면 중립. */
function tagClass(active: boolean): string {
  return active ? 'tag tag-accent' : 'tag tag-neutral';
}

/** tag/q/page 를 보존한 /blog 쿼리스트링 생성(빈 값은 생략). */
function hrefWith(params: { tag?: string; q?: string; page?: number }): string {
  const sp = new URLSearchParams();
  if (params.tag) sp.set('tag', params.tag);
  if (params.q) sp.set('q', params.q);
  if (params.page && params.page > 1) sp.set('page', String(params.page));
  const qs = sp.toString();
  return qs ? `/blog?${qs}` : '/blog';
}

/**
 * 목록 본문 — DB 를 기다리는 부분만 Suspense 안에 둔다.
 *
 * 왜 loading.tsx 가 아니라 페이지 안 Suspense 인가: `blog/loading.tsx` 는 자식인
 * `/blog/[slug]` 까지 덮어 그쪽 응답 상태를 200 으로 굳혀 버린다(soft-404, 2026-09-07 실측).
 * 경계를 이 파일 안으로 좁히면 로딩 골격은 목록에만 걸리고 상세의 404 는 404 로 나간다.
 */
async function BlogListBody({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; tag?: string; page?: string }>;
}) {
  const { q = '', tag = '', page = '1' } = await searchParams;

  // 목록엔 본문이 필요 없다 — 메타만 받는다(131편 기준 4.44MB → 92KB).
  // 검색은 DB 가 본문까지 훑어 매칭 slug 만 돌려준다(searchPostSlugs).
  let posts: PostSummary[];
  let matched: Set<string> | null;
  // 조회수는 관리자에게만 — null 이면 화면에 자리 자체가 없다(비관리자면 조회도 건너뛴다).
  let views: Record<string, number> | null;
  try {
    // 목록·검색은 서로 독립이라 동시에 — 순차로 하면 왕복 시간이 그대로 더해진다.
    [posts, matched] = await Promise.all([getCachedPostSummaries(), searchPostSlugs(q)]);
    views = (await isAdminViewer()) ? await getBlogViewMap() : null;
  } catch {
    return <ErrorState detail="글 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요." />;
  }

  // 태그 목록(빈도 내림차순 → 이름순). 필터 pill 렌더용.
  const tagCount = new Map<string, number>();
  for (const p of posts) for (const t of p.tags ?? []) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
  const allTags = [...tagCount.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t]) => t);
  // 시안 A: 상위 8개만 상시 노출. 선택된 태그가 상위 8 밖이면 노출 줄에 포함시켜 활성 상태를 잃지 않게 한다.
  const TOP_TAGS = 8;
  const primaryTags = allTags.slice(0, TOP_TAGS);
  if (tag && !primaryTags.includes(tag) && allTags.includes(tag)) primaryTags.push(tag);
  const restTags = allTags.filter((t) => !primaryTags.includes(t));

  // 필터: 태그(메모리) → 검색(DB 가 이미 판정한 slug 집합).
  // 본문 대조는 DB 가 했으므로 여기선 집합 조회만 한다.
  const filtered = posts.filter((p) => {
    if (tag && !(p.tags ?? []).includes(tag)) return false;
    if (matched && !matched.has(p.slug)) return false;
    return true;
  });

  // 페이지네이션(10편/쪽).
  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const current = Math.min(Math.max(1, parseInt(page, 10) || 1), totalPages);
  const start = (current - 1) * PER_PAGE;
  const pageItems = filtered.slice(start, start + PER_PAGE);

  return (
    <>
      <BlogSearch initialQuery={q} tag={tag} />

      {/* 태그 필터 — 시안 A(사용자 승인 2026-07-02): 상위 8개 한 줄 + 나머지 더보기 토글 */}
      {allTags.length > 0 && (
        <div className="stack-2">
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <Link href={hrefWith({ q })} className={tagClass(tag === '')}>
              전체
            </Link>
            {primaryTags.map((t) => (
              <Link key={t} href={hrefWith({ tag: t, q })} className={tagClass(tag === t)}>
                #{t}
              </Link>
            ))}
          </div>
          {restTags.length > 0 && (
            <details className="accordion">
              <summary>+{restTags.length} 더보기</summary>
              <div className="accordion-body row" style={{ flexWrap: 'wrap' }}>
                {restTags.map((t) => (
                  <Link key={t} href={hrefWith({ tag: t, q })} className={tagClass(tag === t)}>
                    #{t}
                  </Link>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {/* 결과 요약 */}
      {(q.trim() || tag) && (
        <p className="text-muted">
          {filtered.length > 0 ? `${filtered.length}개의 글` : '일치하는 글이 없습니다.'}
          {tag && <span> · #{tag}</span>}
          {q.trim() && <span> · “{q.trim()}”</span>}
        </p>
      )}

      {posts.length === 0 ? (
        <Empty title="아직 발행된 글이 없습니다" body="곧 새로운 글이 올라올 예정입니다." />
      ) : pageItems.length === 0 ? (
        <Empty title="조건에 맞는 글이 없습니다" body="다른 검색어나 태그를 시도해 보세요." />
      ) : (
        <div className="stack-6">
          {pageItems.map((post) => (
            <Link key={post.slug} href={`/blog/${post.slug}`} className="card card-link">
              {post.tags && post.tags.length > 0 && (
                <span className="card-kicker">{post.tags.map((t) => `#${t}`).join(' ')}</span>
              )}
              <span className="card-title">{post.title}</span>
              {post.description && <p className="card-body">{post.description}</p>}
              <div className="card-meta">
                <time dateTime={post.date}>
                  {post.date
                    ? new Intl.DateTimeFormat('ko-KR', {
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric',
                      }).format(new Date(post.date))
                    : ''}
                </time>
                {/* 구분점도 함께 조건부 — 숫자만 지우면 날짜 뒤에 '·' 가 덩그러니 남는다. */}
                {views !== null && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{(views[post.slug] ?? 0).toLocaleString()} 조회</span>
                  </>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* 페이지네이션 */}
      {totalPages > 1 && (
        <nav className="pagination" aria-label="페이지 이동">
          {current > 1 ? (
            <Link href={hrefWith({ tag, q, page: current - 1 })} className="page-btn" aria-label="이전 페이지">
              <ChevronLeft size={16} aria-hidden="true" />
            </Link>
          ) : (
            <button type="button" className="page-btn" disabled aria-label="이전 페이지">
              <ChevronLeft size={16} aria-hidden="true" />
            </button>
          )}

          {Array.from({ length: totalPages }, (_, i) => i + 1).map((n) => (
            <Link
              key={n}
              href={hrefWith({ tag, q, page: n })}
              aria-current={n === current ? 'page' : undefined}
              className="page-btn"
            >
              {n}
            </Link>
          ))}

          {current < totalPages ? (
            <Link href={hrefWith({ tag, q, page: current + 1 })} className="page-btn" aria-label="다음 페이지">
              <ChevronRight size={16} aria-hidden="true" />
            </Link>
          ) : (
            <button type="button" className="page-btn" disabled aria-label="다음 페이지">
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          )}

          <div className="spacer" />
          <span className="text-muted">
            {start + 1}–{Math.min(start + PER_PAGE, filtered.length)} / {filtered.length}건
          </span>
        </nav>
      )}
    </>
  );
}

export default function BlogListPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; tag?: string; page?: string }>;
}) {
  return (
    <div className="container-narrow">
      <div className="page-head">
        <div>
          <h1 className="page-title">블로그</h1>
          <p className="page-sub">AI 도구 · 자동화 · 생산성</p>
        </div>
      </div>

      <div className="stack-6">
        {/* searchParams 를 await 하지 않고 Promise 그대로 넘긴다 — 머리글은 즉시 그려지고
            DB 를 기다리는 부분만 골격으로 대체된다(상태 3종 중 "로딩"). */}
        <Suspense fallback={<div className="stack-6"><CardSkeleton count={3} /></div>}>
          <BlogListBody searchParams={searchParams} />
        </Suspense>
      </div>
    </div>
  );
}
