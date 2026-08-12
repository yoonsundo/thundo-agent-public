import type { MetadataRoute } from 'next';
import { getSupabase } from '@/lib/supabase';

const BASE = 'https://www.thundo.kr';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: BASE, lastModified: new Date(), changeFrequency: 'weekly', priority: 1 },
    { url: `${BASE}/blog`, lastModified: new Date(), changeFrequency: 'daily', priority: 0.9 },
  ];

  const db = getSupabase();
  if (!db) return staticRoutes;

  const { data } = await db
    .from('blog_posts')
    .select('slug, date')
    .eq('status', 'published')
    .order('date', { ascending: false });

  const postRoutes: MetadataRoute.Sitemap = (data ?? []).map((row) => ({
    url: `${BASE}/blog/${row.slug}`,
    lastModified: row.date ? new Date(row.date) : new Date(),
    changeFrequency: 'monthly' as const,
    priority: 0.7,
  }));

  return [...staticRoutes, ...postRoutes];
}
