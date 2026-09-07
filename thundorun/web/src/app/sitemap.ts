import type { MetadataRoute } from 'next';
import { getSupabase } from '@/lib/supabase';
import { PUBLIC_STATUS } from '@/lib/blog-status';

const BASE = 'https://www.thundo.kr';

/**
 * 1시간마다 다시 만든다.
 *
 * 🔴 예전엔 `revalidate` 가 없어 **빌드 시점에 고정**됐다(빌드 로그의 `○ /sitemap.xml`).
 *    글은 배포와 무관하게 승인 시점에 공개되므로, 배포가 없는 주에 승인한 글은 사이트맵에
 *    영영 안 실렸다 — 색인 요청 신호를 스스로 끊고 있었던 셈이다.
 *    승인 API 가 `revalidatePath('/sitemap.xml')` 로 즉시 갱신도 하지만, 그건 그 경로 하나가
 *    실패하면 조용히 멈춘다. 시간 기반 재검증은 그 실패에 대한 안전망이다(둘 다 둔다).
 */
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: BASE, lastModified: new Date(), changeFrequency: 'weekly', priority: 1 },
    { url: `${BASE}/blog`, lastModified: new Date(), changeFrequency: 'daily', priority: 0.9 },
    // 편집 정책 — 검색엔진이 "이 사이트에 편집 감독이 있는가"를 확인하러 오는 문이다.
    { url: `${BASE}/editorial-policy`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.5 },
  ];

  const db = getSupabase();
  if (!db) return staticRoutes;

  const { data } = await db
    .from('blog_posts')
    .select('slug, date')
    .eq('status', PUBLIC_STATUS)   // 사이트맵은 '색인하라'는 능동 신호다 — 미승인 글을 올리면 안 된다
    .order('date', { ascending: false });

  const postRoutes: MetadataRoute.Sitemap = (data ?? []).map((row) => ({
    url: `${BASE}/blog/${row.slug}`,
    lastModified: row.date ? new Date(row.date) : new Date(),
    changeFrequency: 'monthly' as const,
    priority: 0.7,
  }));

  return [...staticRoutes, ...postRoutes];
}
