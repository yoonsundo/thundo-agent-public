/**
 * blog-isr-cache — 블로그가 캐시를 쓰되, 승인 관문보다 늦지 않게 한다.
 *
 * 실측 배경(2026-09-07): `/blog` 와 `/blog/[slug]` 는 매 요청 `no-store` +
 * `x-vercel-cache: MISS` 였다(TTFB 1.52초 / 0.63초). ISR 인 홈은 0.15초다. 크롤러가 207편을
 * 도는 사이트에서 이 차이는 크롤 예산 그대로다.
 *
 * 그래서 둘을 **다르게** 고쳤다. 그 이유가 이 파일이 지키는 규칙이다:
 *   - `/blog/[slug]` → 진짜 ISR. 요청별 입력이 없다.
 *   - `/blog`        → ISR 불가. `searchParams`(tag·q·page)를 서버에서 읽으므로 캐시된 HTML
 *                      하나로 여러 조건을 만족시킬 수 없다. 대신 **데이터**를 태그 캐시에 담는다.
 *
 * 🔴 캐시를 넣는 대가는 신선도다. 승인 직후 공개가 늦으면 관문이 고장 난 것처럼 보이므로,
 *    쓰기 경로는 예외 없이 무효화를 불러야 한다. 그게 이 파일의 절반이다.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/test/kit';

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: <T,>(fn: T) => fn,
}));

import { revalidatePath, revalidateTag } from 'next/cache';
import { BLOG_CACHE_TAG, BLOG_CACHE_TTL } from '@/lib/blog';
import { revalidateBlog } from '@/server/blogCache';

/**
 * 주석은 지우고 본다 — 이 파일이 금지하는 것을 **설명하는 주석**이 그 금지에 걸려
 * 거짓 실패를 낸다(예: "force-dynamic 을 뺐다"고 적은 주석). design-guard 와 같은 유틸이다.
 */
const read = (rel: string) => stripComments(readFileSync(join(process.cwd(), rel), 'utf8'));
const SLUG_PAGE = 'src/app/(site)/blog/[slug]/page.tsx';
const LIST_PAGE = 'src/app/(site)/blog/page.tsx';

beforeEach(() => vi.clearAllMocks());

describe('무엇을 캐시하는가', () => {
  it('글 상세는 ISR 이다', () => {
    const src = read(SLUG_PAGE);
    expect(src).toMatch(/export const revalidate\s*=\s*\d+/);
    expect(src, 'force-dynamic 이 남아 있으면 캐시가 아예 안 걸린다').not.toMatch(/dynamic\s*=\s*'force-dynamic'/);
  });

  it('sitemap 은 재검증된다 — 없으면 배포 시점에 고정된다', () => {
    // 🔴 글은 배포와 무관하게 승인 시점에 공개된다. revalidate 가 없으면 배포가 없는 주에
    //    승인한 글이 사이트맵에 영영 안 실려, 색인 요청 신호를 스스로 끊는다.
    expect(read('src/app/sitemap.ts')).toMatch(/export const revalidate\s*=\s*[1-9]\d*/);
  });

  it('목록은 ISR 이 아니라 데이터 캐시다 — searchParams 때문에 HTML 을 캐시할 수 없다', () => {
    const src = read(LIST_PAGE);
    expect(src, '캐시된 로더를 안 쓴다').toContain('getCachedPostSummaries');
    expect(src, 'force-dynamic 이 있으면 데이터 캐시까지 함께 꺼진다').not.toMatch(/dynamic\s*=\s*'force-dynamic'/);
    // 목록은 여전히 요청별로 렌더된다 — searchParams 를 읽는다는 사실 자체가 전제다.
    expect(src).toMatch(/searchParams/);
  });

  it('캐시 로더에 수명과 태그가 둘 다 걸려 있다', () => {
    const src = read('src/lib/blog.ts');
    expect(src).toMatch(/tags:\s*\[BLOG_CACHE_TAG\]/);
    expect(src).toMatch(/revalidate:\s*BLOG_CACHE_TTL/);
    // 태그만 있고 수명이 없으면 무효화 호출이 실패한 날 영원히 안 갱신된다(안전망 없음).
    expect(BLOG_CACHE_TTL).toBeGreaterThan(0);
  });
});

describe('무효화 — 승인 관문보다 늦지 않는다', () => {
  it('한 번 부르면 그 글을 그리는 캐시를 전부 버린다', () => {
    revalidateBlog('some-slug');
    const paths = (revalidatePath as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(paths).toContain('/');                 // 홈 ISR — 글 수·인기글
    expect(paths).toContain('/blog/some-slug');   // 상세 ISR (미승인 글의 404 캐시 포함)
    expect(paths).toContain('/sitemap.xml');      // 색인 신호
    expect((revalidateTag as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(BLOG_CACHE_TAG);
  });

  it('slug 가 비면 /blog/ 를 버리지 않는다 — 엉뚱한 항목을 건드린다', () => {
    revalidateBlog('');
    const paths = (revalidatePath as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(paths).not.toContain('/blog/');
    expect(paths).toContain('/');   // 나머지는 그대로 버린다
  });

  /**
   * 쓰기 메서드마다 확인한다. POST 에만 걸고 DELETE 를 빠뜨리면 "지웠는데 아직 보인다"가
   * 되는데, 이건 추가보다 더 이상해 보인다(홈 ISR 에서 같은 실수를 이미 겪었다).
   */
  it.each([
    'src/app/api/admin/blog/route.ts',
    'src/app/api/publish/route.ts',
  ])('%s 의 쓰기 메서드 수만큼 무효화가 있다', (rel) => {
    const src = read(rel);
    const writes = (src.match(/export async function (POST|PUT|PATCH|DELETE)/g) ?? []).length;
    const busts  = (src.match(/revalidateBlog\(/g) ?? []).length;
    expect(writes, '쓰기 메서드가 하나도 없다 — 경로가 바뀐 것 같다').toBeGreaterThan(0);
    expect(busts).toBeGreaterThanOrEqual(writes);
  });

  it('무효화 목록은 한 곳에만 있다 — 쓰기 경로가 둘이라 복제하면 한쪽만 늘어난다', () => {
    for (const rel of ['src/app/api/admin/blog/route.ts', 'src/app/api/publish/route.ts']) {
      expect(read(rel), `${rel} 이 무효화 목록을 자체 보유함`).not.toMatch(/revalidatePath\(/);
    }
  });
});
