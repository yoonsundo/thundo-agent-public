import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, ShieldCheck } from 'lucide-react';
import { getPost, getCachedPostSummaries, pickRelated } from '@/lib/blog';
import { parseFaq } from '@/lib/faq';
import HtmlView from '@/components/HtmlView';
import PrintButton from '@/components/PrintButton';
import ShareButtons from '@/components/ShareButtons';
import RelatedPosts from '@/components/RelatedPosts';
import AdminBlogViews from '@/components/AdminBlogViews';
import { buildToc } from '@/lib/toc';

/**
 * ISR 5분 — 글 상세는 요청별 입력(쿼리·쿠키)이 없으므로 정적 재검증으로 충분하다.
 *
 * 왜 바꿨나: 예전엔 `force-dynamic` 이라 매 요청이 `no-store` + `x-vercel-cache: MISS` 였다
 * (실측 TTFB 0.63초, ISR 인 홈은 0.15초). 크롤러가 207편을 도는 사이트에서 이 차이는
 * 크롤 예산 그대로다.
 *
 * ⚠ 승인 관문과 충돌하지 않게 하는 것이 조건이다. 5분을 기다리면 "승인했는데 안 보인다"가
 *    되고, 미승인 글은 notFound() → **404 응답까지 캐시된다**. 그래서 `/api/admin/blog` 의
 *    승인(PATCH)·저장(POST)·삭제가 `revalidatePath('/blog/<slug>')` 로 그 글의 캐시를 즉시
 *    버린다. 무효화를 승인 API 에 두는 이유는 공개 여부가 바뀌는 지점이 거기 하나이기
 *    때문이다 — 페이지 쪽 revalidate 를 짧게 주는 방식은 "즉시 반영"과 "캐시 효과"를 동시에
 *    가질 수 없다. (2026-08-28 홈 ISR 에서 같은 문제를 같은 처방으로 고쳤다.)
 *
 * 🔴 조회수를 서버에서 읽지 않는다. ISR 캐시는 전 방문자가 공유해 세션별 분기가 불가능하다
 *    — 서버에서 조건부로 그리면 먼저 온 사람의 화면이 캐시에 굳는다. 관리자만 클라이언트
 *    (AdminBlogViews)에서 따로 받아 온다.
 */
export const revalidate = 300;

/**
 * 빈 배열 + dynamicParams(기본 true) = "빌드 때는 하나도 미리 만들지 않되, 요청이 오면
 * 만들어서 캐시한다".
 *
 * 🔴 이 선언이 없으면 Next 는 `[slug]` 를 순수 동적 라우트로 보고 위의 revalidate 를 **무시**한다
 *    (실측: 빌드 표의 Revalidate 열이 비고 응답이 `no-store` 로 나갔다 — ISR 을 켠 줄 알았는데
 *    아무것도 안 바뀐 상태였다). 선언을 넣자 `s-maxage=300` 으로 바뀌었다.
 *
 * 207편을 빌드 시점에 미리 만들지 않는 이유: 승인은 배포와 무관하게 아무 때나 일어나므로
 * 빌드 때 뽑은 목록은 그날로 낡는다. 첫 요청에서 만들고, 승인 API 가 그 글만 무효화한다.
 */
export function generateStaticParams(): { slug: string }[] {
  return [];
}

const BASE = 'https://www.thundo.kr';

/** JSON-LD 삽입 시 XSS 방지: < → < */
function safeJson(obj: unknown): string {
  return JSON.stringify(obj).replace(/</g, '\\u003c');
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = await getPost(slug);
  if (!post) return {};

  // <title> 은 루트 layout 의 `template: '%s — Thundo'` 가 브랜드를 붙인다 — 여기서 또 붙이면
  // "제목 — Thundo — Thundo" 가 된다(실제로 116편 전부 이렇게 나갔다).
  // og/twitter title 은 템플릿이 적용되지 않는 필드라 브랜드를 직접 붙인다.
  const title       = post.title;
  const socialTitle = `${post.title} — Thundo`;
  const description = post.description ?? post.title;
  const canonical   = `/blog/${slug}`;        // metadataBase가 https://www.thundo.kr 로 절대화

  return {
    title,
    description,
    alternates: {
      canonical,
    },
    openGraph: {
      type:          'article',
      title:         socialTitle,
      description,
      publishedTime: post.date ? `${post.date}T00:00:00+09:00` : undefined,
      tags:          post.tags?.length ? post.tags : undefined,
      // og:image: 적합한 1200×630 이미지가 없어 생략 (profile.png 559×492, icon-512.png 512×512)
    },
    twitter: {
      card:        'summary_large_image',
      title:       socialTitle,
      description,
    },
  };
}

interface TocNode {
  slug: string;
  text: string;
  children: { slug: string; text: string }[];
}

export default async function BlogPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = await getPost(slug);
  if (!post) notFound();

  // 관련글·인접글용 경량 메타(본문 제외). date 내림차순.
  const summaries = await getCachedPostSummaries();
  const related = pickRelated(
    { slug: post.slug, title: post.title, date: post.date, description: post.description, tags: post.tags },
    summaries,
    3,
  );
  // 이전/다음 글 — date 내림차순 배열에서 index-1 이 최신(다음), index+1 이 과거(이전).
  const idx = summaries.findIndex((p) => p.slug === post.slug);
  const newerPost = idx > 0 ? summaries[idx - 1] : null;                                  // 다음 글(최신)
  const olderPost = idx >= 0 && idx < summaries.length - 1 ? summaries[idx + 1] : null;   // 이전 글(과거)

  // BlogPosting JSON-LD
  const canonicalUrl = `${BASE}/blog/${slug}`;
  const isoDate = post.date ? `${post.date}T00:00:00+09:00` : undefined;

  /**
   * 사람 검수 기록 — **있을 때만** 말한다.
   *
   * 🔴 승인 관문(2026-09-07) 이전에 자동 발행된 207편은 approved_by 가 null 이다. 백필하지
   *    않았다 — 실제로 사람이 검수한 적이 없기 때문이다. 여기에 아무 이름이나 채우면 구조화
   *    데이터로 거짓을 말하는 것이고, 그건 8월 스팸 업데이트가 겨냥한 바로 그 행위다.
   *    둘 다 있을 때만 표시한다(이름만 있고 시각이 없으면 기록이 깨진 것이므로 믿지 않는다).
   */
  const reviewer = post.approvedBy && post.approvedAt
    ? { name: post.approvedBy, at: post.approvedAt }
    : null;

  const blogPostingLd = {
    '@context':        'https://schema.org',
    '@type':           'BlogPosting',
    headline:          post.title,
    description:       post.description ?? post.title,
    datePublished:     isoDate,
    // 사람이 검수해 공개한 시각이 곧 마지막으로 손댄 시각이다. 기록이 없으면 발행일과 동일
    // (수정 이력을 따로 추적하지 않으므로 그게 정직한 기본값이다).
    dateModified:      reviewer?.at ?? isoDate,
    author:            { '@type': 'Person', name: 'Thundo' },
    publisher:         { '@id': `${BASE}/#organization` },   // 루트 layout 의 전역 Organization 참조
    // ⚠ schema.org 에서 reviewedBy·lastReviewed 의 정의역은 WebPage 다. BlogPosting 에도
    //    같이 다는 것은 소비자(검색엔진)마다 읽는 노드가 달라서인데, 정본은 이 WebPage 쪽이다.
    mainEntityOfPage:  {
      '@type': 'WebPage',
      '@id':   canonicalUrl,
      ...(reviewer ? {
        reviewedBy:   { '@type': 'Person', name: reviewer.name },
        lastReviewed: reviewer.at,
      } : {}),
    },
    ...(reviewer ? { reviewedBy: { '@type': 'Person', name: reviewer.name } } : {}),
    inLanguage:        'ko',
    ...(post.tags?.length ? { keywords: post.tags.join(', ') } : {}),
  };

  // BreadcrumbList JSON-LD — 홈 > 블로그 > 현재 글
  const breadcrumbLd = {
    '@context':      'https://schema.org',
    '@type':         'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: '홈',   item: BASE },
      { '@type': 'ListItem', position: 2, name: '블로그', item: `${BASE}/blog` },
      { '@type': 'ListItem', position: 3, name: post.title, item: canonicalUrl },
    ],
  };

  // FAQPage JSON-LD — FAQ 쌍이 3개 이상일 때만 출력 (faq-contract.md)
  const faqItems = parseFaq(post.content);
  const faqPageLd = faqItems.length >= 3
    ? {
        '@context':  'https://schema.org',
        '@type':     'FAQPage',
        mainEntity:  faqItems.map((item) => ({
          '@type':        'Question',
          name:           item.question,
          acceptedAnswer: { '@type': 'Answer', text: item.answer },
        })),
      }
    : null;

  const formattedDate = post.date
    ? new Intl.DateTimeFormat('ko-KR', {
        year:  'numeric',
        month: 'long',
        day:   'numeric',
      }).format(new Date(post.date))
    : '';

  // 검수일 표기 — approved_at 은 timestamptz(UTC)라 KST 로 읽어야 승인한 날과 같은 날이 된다.
  const reviewedDate = reviewer
    ? new Intl.DateTimeFormat('ko-KR', {
        year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Seoul',
      }).format(new Date(reviewer.at))
    : '';

  // 본문 헤딩에서 목차 추출 + id 주입. H3 는 직전 H2 아래로 중첩.
  const { html, headings } = buildToc(post.content);
  const tocTree: TocNode[] = [];
  for (const h of headings) {
    if (h.depth === 2) {
      tocTree.push({ slug: h.slug, text: h.text, children: [] });
    } else if (h.depth === 3) {
      if (tocTree.length > 0) tocTree[tocTree.length - 1].children.push({ slug: h.slug, text: h.text });
      else tocTree.push({ slug: h.slug, text: h.text, children: [] });
    }
  }

  return (
    <article>
      {/* JSON-LD 구조화 데이터 */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJson(blogPostingLd) }}
      />
      {faqPageLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: safeJson(faqPageLd) }}
        />
      )}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJson(breadcrumbLd) }}
      />
      <div className="container-narrow">
        <div className="page-head">
          <div>
            {post.tags && post.tags.length > 0 && (
              <div className="row" style={{ flexWrap: 'wrap' }}>
                {post.tags.map((t) => (
                  <span key={t} className="tag tag-neutral">
                    #{t}
                  </span>
                ))}
              </div>
            )}
            <h1 className="page-title">{post.title}</h1>
            <p className="page-sub row">
              <time dateTime={post.date}>{formattedDate}</time>
              {/* 검수 기록이 있는 글만 검수자를 밝힌다. 없는 글은 이 줄 자체가 없다 —
                  구분점까지 조건부로 묶지 않으면 날짜 뒤에 '·' 가 덩그러니 남는다. */}
              {reviewer && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="row">
                    <ShieldCheck size={14} aria-hidden="true" />
                    검수: {reviewer.name} · <time dateTime={reviewer.at}>{reviewedDate}</time>
                  </span>
                </>
              )}
              {/* 조회수는 관리자만 — 서버가 아니라 클라이언트에서 받아 온다(ISR 캐시 공유). */}
              <AdminBlogViews slug={slug} />
            </p>
          </div>
          <div className="page-actions" data-noprint>
            <PrintButton />
          </div>
        </div>

        <div className="stack-6">
          {/* 인트로 요약 콜아웃은 제거했다(2026-08-19).
              `description` 이 본문 첫 문단을 그대로 잘라 만든 값이라, 화면에서 같은 문장이
              연속으로 두 번 나왔다(표본 5편 전부 중복 — 라이브 실측). 독자가 방금 읽은 문장을
              다시 읽게 되고 도입부가 두 배로 길어진다. 첫 문단이 이미 도입부 역할을 하므로 상자를 뺀다.
              ⚠ `description` 자체는 그대로 둔다 — metadata·OG·JSON-LD 에 계속 쓰인다(:34,:39,:46,:54,:91). */}

          {/* 이 글의 순서 (헤딩 자동 추출, H3 는 H2 아래 중첩) */}
          {tocTree.length > 0 && (
            <nav className="card card-outline" aria-label="이 글의 순서">
              <span className="card-kicker">이 글의 순서</span>
              <ol className="stack-2">
                {tocTree.map((h) => (
                  <li key={h.slug}>
                    <a href={`#${h.slug}`}>{h.text}</a>
                    {h.children.length > 0 && (
                      <ol className="stack-2">
                        {h.children.map((c) => (
                          <li key={c.slug}>
                            <a href={`#${c.slug}`}>{c.text}</a>
                          </li>
                        ))}
                      </ol>
                    )}
                  </li>
                ))}
              </ol>
            </nav>
          )}

          {/* 본문 — HTML 렌더러 (sanitize + .article) */}
          <HtmlView content={html} />

          {/* 공유 */}
          <div className="row" data-noprint>
            <span className="text-muted">이 글이 도움이 됐다면 공유해 주세요</span>
            <div className="spacer" />
            <ShareButtons url={canonicalUrl} title={post.title} />
          </div>

          {/* 이전/다음 글 */}
          {(olderPost || newerPost) && (
            <nav className="grid-2" aria-label="이전 다음 글" data-noprint>
              {olderPost ? (
                <Link href={`/blog/${olderPost.slug}`} className="card card-link">
                  <span className="card-kicker row">
                    <ChevronLeft size={14} aria-hidden="true" /> 이전 글
                  </span>
                  <span className="card-title">{olderPost.title}</span>
                </Link>
              ) : <span />}
              {newerPost ? (
                <Link href={`/blog/${newerPost.slug}`} className="card card-link">
                  <span className="card-kicker row">
                    다음 글 <ChevronRight size={14} aria-hidden="true" />
                  </span>
                  <span className="card-title">{newerPost.title}</span>
                </Link>
              ) : <span />}
            </nav>
          )}

          {/* 관련 글 */}
          <RelatedPosts posts={related} />

          {/* 편집 정책 — 이 글이 어떻게 만들어지고 누가 검수했는지로 가는 문.
              검수 기록이 없는 글(관문 이전 207편)에도 필요하다: 검수자를 못 밝히는 이유까지
              정책 페이지가 설명하므로, 여기서 링크를 감추면 오히려 설명이 사라진다. */}
          <aside className="card card-outline" data-noprint>
            <span className="card-kicker">이 글은 이렇게 만들어졌습니다</span>
            <p className="card-body">
              AI 에이전트가 초안을 쓰고, 자동 게이트와 검증 에이전트를 통과한 글만 사람이 검수해
              공개합니다.{' '}
              <Link href="/editorial-policy">편집 정책 · AI 사용 고지 · 정정 절차</Link>
            </p>
          </aside>

          {/* 뒤로가기 */}
          <div data-noprint>
            <Link href="/blog" className="btn btn-ghost">
              <ChevronLeft size={16} aria-hidden="true" /> 블로그 목록으로
            </Link>
          </div>
        </div>
      </div>
    </article>
  );
}
