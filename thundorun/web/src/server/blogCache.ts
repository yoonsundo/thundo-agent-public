/**
 * server/blogCache.ts — 글 하나의 공개 상태가 바뀐 뒤 그 글을 그리는 **모든 캐시**를 버린다.
 *
 * 🔴 여기가 승인 관문과 캐시가 만나는 지점이다. 상세(/blog/[slug])는 ISR(5분)이고 미승인
 *    글은 notFound() 라 **404 응답까지 캐시된다**. 이 무효화가 없으면 승인해도 최대 5분간
 *    404 가 그대로 나가고, 관리자 눈에는 "승인 버튼이 고장 났다"로 보인다.
 *
 * ⚠ 소비자를 페이지가 아니라 **데이터로** 센다. "그 페이지는 force-dynamic 이라 무효화
 *    불필요"라고 판단했다가, 같은 데이터를 그리는 다른 ISR 화면(홈)을 놓친 적이 있다
 *    (2026-08-28). 그래서 쓰기 경로가 둘(관리자 승인 · /api/publish)인데도 함수는 하나다 —
 *    목록을 각자 들고 있으면 한쪽만 늘어난다.
 *
 * 버리는 것:
 *   - `/`             홈 ISR — 글 수·인기글 목록을 그린다
 *   - BLOG_CACHE_TAG  /blog 목록과 상세의 관련글이 함께 쓰는 데이터 캐시
 *   - `/blog/<slug>`  상세 ISR 본문(404 캐시 포함)
 *   - `/sitemap.xml`  ISR — 색인 신호라 늦으면 색인이 늦는다
 * RSS(feed.xml)·llms.txt 는 force-dynamic 이라 매 요청 새로 만든다(무효화 대상 아님).
 */
import { revalidatePath, revalidateTag } from 'next/cache';
import { BLOG_CACHE_TAG } from '@/lib/blog';

export function revalidateBlog(slug: string): void {
  revalidatePath('/');
  // 2번째 인자는 "이 무효화 표시를 얼마나 오래 유효하게 볼 것인가"다(Next 16 에서 필수가 됐다).
  // 'max' = 만료 없음 — 표시가 캐시 항목보다 먼저 사라지면 그 항목이 살아남아 옛 목록을 계속
  // 준다. 태그는 하나뿐이라 영구 보관해도 비용이 사실상 없으니 안전한 쪽으로 둔다.
  revalidateTag(BLOG_CACHE_TAG, 'max');
  // slug 가 비면 경로가 `/blog/` 가 돼 엉뚱한 항목을 버린다 — 있을 때만 부른다.
  if (slug) revalidatePath(`/blog/${slug}`);
  revalidatePath('/sitemap.xml');
}
