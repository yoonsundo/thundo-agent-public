/**
 * app/feed.xml/route.ts — RSS 2.0 피드
 * 발행 글 전체를 date 내림차순으로 포함. Content-Type: application/xml.
 *
 * 네이버 서치어드바이저 공식 권장: RSS 에 본문 전체를 담는다(요약만이 아니라).
 * → <content:encoded> 에 본문 HTML(페이지와 동일 렌더러 buildToc)을 CDATA 로 포함.
 *   (페이지는 여기에 sanitize 를 한 번 더 얹지만 발행 시 mdToHtml·render-fit 게이트를
 *    통과한 신뢰 콘텐츠라 RSS 산출은 실질 동등.)
 */
import { NextResponse } from 'next/server';
import { getAllPosts } from '@/lib/blog';
import { buildToc } from '@/lib/toc';

export const dynamic = 'force-dynamic';

const BASE = 'https://www.thundo.kr';

/** XML 특수문자 이스케이프 (title·description 등 요소값용) */
function xe(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** CDATA 래핑 — 본문 HTML 을 그대로 담되 "]]>" 시퀀스만 안전 분할 */
function cdata(html: string): string {
  return `<![CDATA[${String(html ?? '').replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

export async function GET() {
  const posts = (await getAllPosts()).slice(0, 30);   // 최근 30편만 전문 포함(크롤러는 최신 윈도우만 필요)

  const items = posts
    .map((post) => {
      const link = `${BASE}/blog/${post.slug}`;
      const pubDate = post.date
        ? new Date(post.date).toUTCString()
        : new Date().toUTCString();
      // 본문은 페이지와 동일한 렌더 HTML(buildToc)로 전문 포함
      const bodyHtml = buildToc(post.content).html;
      const categories = (post.tags ?? [])
        .map((t) => `      <category>${xe(t)}</category>`)
        .join('\n');
      return `    <item>
      <title>${xe(post.title)}</title>
      <link>${link}</link>
      <description>${xe(post.description ?? post.title)}</description>
      <content:encoded>${cdata(bodyHtml)}</content:encoded>
      <pubDate>${pubDate}</pubDate>
      <guid isPermaLink="true">${link}</guid>${categories ? '\n' + categories : ''}
    </item>`;
    })
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Thundo</title>
    <link>${BASE}</link>
    <description>AI 코딩 도구 · 자동화 · 생산성</description>
    <language>ko</language>
    <atom:link href="${BASE}/feed.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>`;

  return new NextResponse(xml, {
    headers: {
      'Content-Type':  'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
