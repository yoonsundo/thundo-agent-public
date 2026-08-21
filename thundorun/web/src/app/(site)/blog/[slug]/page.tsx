import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, Eye } from 'lucide-react';
import { getPost, getPostSummaries, pickRelated } from '@/lib/blog';
import { getBlogViews } from '@/server/blogViews';
import { isAdminViewer } from '@/server/adminViewer';
import { parseFaq } from '@/lib/faq';
import HtmlView from '@/components/HtmlView';
import PrintButton from '@/components/PrintButton';
import ShareButtons from '@/components/ShareButtons';
import RelatedPosts from '@/components/RelatedPosts';
import { buildToc } from '@/lib/toc';

// DB 기반 — 정적 사전생성 불필요, 요청 시 서버 렌더
export const dynamic = 'force-dynamic';

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
  // 조회수는 관리자에게만 — 비관리자면 DB 조회조차 하지 않는다(유출 차단 + 왕복 1회 절약).
  const views = (await isAdminViewer()) ? await getBlogViews(slug) : null;

  // 관련글·인접글용 경량 메타(본문 제외). date 내림차순.
  const summaries = await getPostSummaries();
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
  const blogPostingLd = {
    '@context':        'https://schema.org',
    '@type':           'BlogPosting',
    headline:          post.title,
    description:       post.description ?? post.title,
    datePublished:     isoDate,
    dateModified:      isoDate,   // 수정 이력 미추적 → 발행일과 동일(정직한 기본값)
    author:            { '@type': 'Person', name: 'Thundo' },
    publisher:         { '@id': `${BASE}/#organization` },   // 루트 layout 의 전역 Organization 참조
    mainEntityOfPage:  { '@type': 'WebPage', '@id': canonicalUrl },
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
              {/* 구분점도 함께 조건부 — 숫자만 지우면 날짜 뒤에 '·' 가 덩그러니 남는다. */}
              {views !== null && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="row">
                    <Eye size={14} aria-hidden="true" /> {views.toLocaleString()} 조회
                  </span>
                </>
              )}
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
