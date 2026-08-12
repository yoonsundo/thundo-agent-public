/**
 * app/llms.txt/route.ts — llms.txt (llmstxt.org 규약)
 *
 * AI 검색엔진(ChatGPT·Claude·Perplexity 등)이 사이트 구조·핵심 콘텐츠를 이해하도록
 * 큐레이션한 카탈로그. AEO/GEO(생성형 엔진 최적화) 목적 — robots.txt 의 AI 크롤러
 * 허용과 짝을 이룬다. 발행글을 date 내림차순으로 자동 생성(경량 메타 로더 사용).
 *
 * ⚠ 화이트햇: 실제 발행된 글만 노출. 가짜 콘텐츠·조작 없음.
 */
import { NextResponse } from 'next/server';
import { getPostSummaries } from '@/lib/blog';

export const dynamic = 'force-dynamic';

const BASE = 'https://www.thundo.kr';

export async function GET() {
  const posts = await getPostSummaries();
  const recent = posts.slice(0, 30);

  const postLines = recent
    .map((p) => {
      const desc = p.description ? `: ${p.description}` : '';
      return `- [${p.title}](${BASE}/blog/${p.slug})${desc}`;
    })
    .join('\n');

  const text = `# Thundo

> AI 코딩 도구·자동화·생산성을 다루는 한국어 기술 블로그. 개발자가 실제로 써본 AI 툴·자동화 워크플로·생산성 팁을, 사실 검증·품질 게이트를 통과한 글로만 발행합니다.

니치: 한국어 사용자를 위한 AI 개발 도구 실전 가이드(Claude Code·Cursor 등).

## 안내 (AI 크롤러)

- ai-input: yes   # 답변 인용(citation) 허용
- ai-train: no    # 모델 학습 사용은 비허용

## 주요 섹션

- [블로그 목록](${BASE}/blog)
- [RSS 피드](${BASE}/feed.xml)
- [사이트맵](${BASE}/sitemap.xml)

## 최신 글 (최대 30편)

${postLines || '- (아직 발행된 글이 없습니다)'}
`;

  return new NextResponse(text, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
