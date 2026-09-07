/**
 * lib/blog-status.ts — 블로그 글의 공개 경계를 한 곳에 둔다 (순수 · DB 접근 없음).
 *
 * 왜 별도 모듈인가: 경계를 판정하는 규칙이 서버(blog.ts·라우트)와 클라이언트(관리자 화면)
 * 양쪽에 필요한데, blog.ts 는 supabase 를 import 해서 'use client' 컴포넌트가 못 쓴다.
 * 규칙이 두 곳에 복제되면 한쪽만 고쳐져 조용히 어긋난다 — 그래서 값이 아니라 **이름**으로 잠근다.
 *
 * 상태 셋의 뜻은 supabase/blog_posts.sql 의 comment 와 같다:
 *   draft     — 사람이 쓰다 만 글
 *   ready     — 파이프라인 산출물, 사람 승인 대기 (관리자 화면에만 보인다)
 *   published — 사람이 승인해 공개된 글  ← 공개 경계는 이 값 하나
 */

/** 공개 페이지·sitemap·RSS·llms.txt 에 나갈 수 있는 유일한 상태. */
export const PUBLIC_STATUS = 'published' as const;

/** DB 가 허용하는 상태 전체 (blog_posts_status_chk 와 같은 집합). */
export const BLOG_STATUSES = ['draft', 'ready', 'published'] as const;

export type BlogStatus = (typeof BLOG_STATUSES)[number];

/** 승인 대기 — 관리자 화면에는 보이고 공개 경로에는 절대 안 나가는 상태. */
export const PENDING_STATUS = 'ready' as const;

/**
 * 임의 입력을 상태로 정규화한다. **모르는 값은 공개로 올리지 않는다**(fail-closed).
 *
 * 🔴 예전 /api/publish 는 `status === 'draft' ? 'draft' : 'published'` 였다 —
 *    'ready' 를 보내면 조용히 'published' 가 돼 승인 관문을 그냥 통과했다.
 *    화이트리스트가 아닌 판정은 새 상태가 생기는 순간 이렇게 뚫린다.
 *
 * @param v   외부에서 들어온 값(JSON 본문·폼 등)
 * @param fallback 값이 없거나(undefined·null·빈 문자열) 알 수 없을 때 쓸 상태
 */
export function normalizeStatus(v: unknown, fallback: BlogStatus): BlogStatus {
  if (typeof v !== 'string') return fallback;
  const s = v.trim().toLowerCase();
  return (BLOG_STATUSES as readonly string[]).includes(s) ? (s as BlogStatus) : fallback;
}

/** 이 상태의 글이 공개 경로에 나가도 되는가. */
export function isPublic(status: unknown): boolean {
  return status === PUBLIC_STATUS;
}

/** 관리자 화면 배지 문구·톤 (Modernist Kit `.tag` 변형). */
export function statusLabel(status: BlogStatus): { text: string; tone: string } {
  if (status === 'published') return { text: '발행됨',    tone: 'tag tag-success' };
  if (status === 'ready')     return { text: '승인 대기', tone: 'tag tag-accent'  };
  return                             { text: '초안',      tone: 'tag tag-warning' };
}
