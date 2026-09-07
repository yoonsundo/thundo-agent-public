/**
 * blog-views-admin-only.test.tsx — 블로그 조회수가 관리자에게만 보이는 경계를 고정한다.
 *
 * 🔴 이 테스트가 지키는 것은 "안 보인다"가 아니라 **"보내지 않는다"** 이다.
 *    CSS 로 감추는 구현으로 되돌아가면 렌더 결과에 숫자가 남아 여기서 깨진다.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { stripComments } from '@/test/kit';
import ProjectsDashboard, { type PopularPost, type Profile, type Stat } from '@/components/ProjectsDashboard';
import { isAdminSession } from '@/server/adminViewer';
import { answerSiteQuestion } from '@/server/siteGuide';
import { toPublicPopularPosts } from '@/server/popularPosts';
import type { SiteProfileData } from '@/server/siteProfile';

// useSession 은 SessionProvider 없이도 동작하도록 스텁 — 로그인 상태를 케이스별로 바꾼다.
const sessionMock = vi.hoisted(() => ({ value: { data: null as unknown, status: 'unauthenticated' } }));
vi.mock('next-auth/react', () => ({ useSession: () => sessionMock.value }));
vi.mock('next/navigation', () => ({ usePathname: () => '/' }));

const profile: Profile = {
  name: '테스트', handle: 'test', title: '제목', bio: '소개',
  avatar: '', skills: [], socials: [],
};
const stats: Stat[] = [];
const posts: PopularPost[] = [
  { slug: 'a', title: '첫 번째 글', date: '2026-01-01', views: 12345 },
  { slug: 'b', title: '두 번째 글', date: '2026-01-02', views: 999 },
];

/** views 를 뺀 형태 — 서버가 비관리자에게 넘기는 실제 모양(프로덕션과 같은 함수로 만든다). */
const postsWithoutViews: PopularPost[] = toPublicPopularPosts(posts);

describe('관리자 판정', () => {
  it('role==="admin" 일 때만 true 다', () => {
    expect(isAdminSession({ user: { role: 'admin' } })).toBe(true);
    expect(isAdminSession({ user: { role: 'user' } })).toBe(false);
    expect(isAdminSession({ user: {} })).toBe(false);
    expect(isAdminSession({ user: null })).toBe(false);
    expect(isAdminSession(null)).toBe(false);
    expect(isAdminSession(undefined)).toBe(false);
  });
});

describe('공개 변환 — 조회수를 형태에서 제거한다', () => {
  it('views 키 자체가 남지 않는다', () => {
    const out = toPublicPopularPosts(posts);
    expect(Object.keys(out[0])).toEqual(['slug', 'title', 'date']);
    // 키 이름을 바꿔 숨기는 변형도 잡는다 — 값이 직렬화에 남으면 실패.
    expect(JSON.stringify(out)).not.toContain('12345');
    expect(JSON.stringify(out)).not.toContain('999');
  });

  it('순서는 입력 그대로 유지한다(순위 보존)', () => {
    expect(toPublicPopularPosts(posts).map((p) => p.slug)).toEqual(['a', 'b']);
  });
});

describe('홈 인기블로그 — 조회수 노출', () => {
  it('views 가 없으면 숫자를 그리지 않고 순위·제목은 남는다', () => {
    sessionMock.value = { data: null, status: 'unauthenticated' };
    render(<ProjectsDashboard profile={profile} stats={stats} popularPosts={postsWithoutViews} videos={[]} agents={[]} />);

    // 순위 목록 자체는 유지 — 가려야 하는 건 숫자이지 인기 순서가 아니다.
    expect(screen.getByText('첫 번째 글')).toBeInTheDocument();
    expect(screen.getByText('두 번째 글')).toBeInTheDocument();
    // 숫자는 어떤 표기로도 남지 않아야 한다.
    expect(screen.queryByText(/12,345/)).not.toBeInTheDocument();
    expect(screen.queryByText(/12345/)).not.toBeInTheDocument();
    expect(screen.queryByText(/999/)).not.toBeInTheDocument();
    // ⚠ 위 세 줄만으로는 약하다 — 예전 구현(views 를 무조건 포맷)은 undefined 를 받아
    //   'NaN 회' 를 그리므로 위 단언을 전부 통과한다. 조회수 칩이 **아예 없는지**로 잠근다.
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
    expect(screen.queryByText(/회$/)).not.toBeInTheDocument();
  });

  it('views 가 채워져 있으면 숫자를 그린다(prop 경로)', () => {
    sessionMock.value = { data: { user: { role: 'admin' } }, status: 'authenticated' };
    render(<ProjectsDashboard profile={profile} stats={stats} popularPosts={posts} videos={[]} agents={[]} />);
    expect(screen.getByText(/12,345\s*회/)).toBeInTheDocument();
  });

  // 🔴 프로덕션에서 관리자가 숫자를 보는 경로는 위 prop 이 아니라 **이 fetch 뿐이다**
  //    (서버가 views 를 절대 넘기지 않으므로). 여기가 비면 실제 경로가 무검증으로 남는다.
  it('관리자는 fetch 로 받아 그린다 — 실제 프로덕션 경로', async () => {
    sessionMock.value = { data: { user: { role: 'admin' } }, status: 'authenticated' };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ a: 777 }) });
    vi.stubGlobal('fetch', fetchMock);

    render(<ProjectsDashboard profile={profile} stats={stats} popularPosts={postsWithoutViews} videos={[]} agents={[]} />);

    expect(await screen.findByText(/777\s*회/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/popular-views');
    vi.unstubAllGlobals();
  });

  it('비관리자에겐 요청조차 보내지 않는다', () => {
    sessionMock.value = { data: null, status: 'unauthenticated' };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<ProjectsDashboard profile={profile} stats={stats} popularPosts={postsWithoutViews} videos={[]} agents={[]} />);

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

/**
 * 컴포넌트 테스트는 "서버가 숫자를 넘기지 않는다"를 증명할 수 없다 — 그건 다른 파일의 책임이다.
 * 유출 경계는 서버 소스에 있으므로 소스 수준으로 잠근다(design-guard 와 같은 방식).
 */
describe('서버 경계 — 숫자를 애초에 보내지 않는다', () => {
  // 주석은 지우고 본다 — 주석에 적힌 "getBlogViewMap 을 쓰지 말 것" 같은 설명이
  // 금지 단언에 걸려 거짓 실패를 낸다. design-guard 가 쓰는 유틸을 그대로 재사용한다.
  const read = (rel: string) => stripComments(readFileSync(join(process.cwd(), rel), 'utf8'));

  it('홈(ISR)은 공개 변환 함수를 통과시킨다', () => {
    const src = read('src/app/(site)/page.tsx');
    // ISR 은 세션별 분기가 불가능하다 — 캐시를 지키려면 숫자를 빼는 것 외의 방법이 없다.
    expect(src).toMatch(/export const revalidate\s*=\s*300/);
    // 소스 가드는 "이 함수를 거치는가"만 본다. 무엇을 버리는지는 아래 동작 테스트가 잠근다.
    expect(src, 'toPublicPopularPosts 를 거치지 않음').toMatch(/toPublicPopularPosts\(/);
  });

  // 목록(/blog)은 searchParams 때문에 ISR 이 불가능해 동적 렌더로 남았다 — 세션을 읽을 수
  // 있으므로 서버에서 관리자만 조회한다.
  it('src/app/(site)/blog/page.tsx 는 관리자일 때만 조회수를 읽는다', () => {
    const src = read('src/app/(site)/blog/page.tsx');
    expect(src, 'isAdminViewer import 없음').toContain("from '@/server/adminViewer'");
    expect(src, 'isAdminViewer 호출 없음').toMatch(/isAdminViewer\(\)/);
    // 무조건 조회 금지 — 조건 없이 대입하면 비관리자도 DB 왕복이 생기고 숫자가 렌더로 흘러간다.
    expect(src, '조회수를 조건 없이 조회함').not.toMatch(/^\s*(?:const |let )?views\s*=\s*await getBlogView/m);
  });

  /**
   * 🔴 글 상세(/blog/[slug])는 2026-09-07 에 ISR 로 바뀌었다. 캐시된 HTML 하나를 전 방문자가
   *    공유하므로 **세션별 분기 자체가 불가능**하다 — 서버에서 `isAdminViewer()` 로 조건부
   *    렌더하면 먼저 온 사람의 화면이 캐시에 굳어 비관리자에게도 숫자가 나간다.
   *    그래서 여기서 요구하는 것은 목록과 정반대다: **세션도 조회수도 서버에서 읽지 마라.**
   */
  it('src/app/(site)/blog/[slug]/page.tsx 는 ISR 이라 조회수를 서버에서 읽지 않는다', () => {
    const src = read('src/app/(site)/blog/[slug]/page.tsx');
    expect(src, 'ISR 이 아님 — 이 검사의 전제가 사라졌다').toMatch(/export const revalidate\s*=\s*\d+/);
    expect(src, 'force-dynamic 이 남아 있으면 ISR 이 아니다').not.toMatch(/dynamic\s*=\s*'force-dynamic'/);
    expect(src, 'ISR 페이지가 세션을 읽는다').not.toContain('@/server/adminViewer');
    expect(src, 'ISR 페이지가 조회수를 서버에서 읽는다').not.toContain('getBlogViews');
    // 관리자 경로가 아예 사라진 것도 회귀다 — 클라이언트 컴포넌트로 옮겼는지 확인한다.
    expect(src, '관리자 조회수 경로가 없다').toContain('AdminBlogViews');
  });

  it('site-chat 라우트가 canSeeViews 를 판정해 넘긴다', () => {
    const src = read('src/app/api/site-chat/route.ts');
    expect(src).toMatch(/isAdminViewer\(\)/);
    expect(src).toMatch(/canSeeViews/);
  });

  it('관리자 조회수 엔드포인트는 홈 순위와 같은 집계 창을 쓴다', () => {
    const src = read('src/app/api/admin/popular-views/route.ts');
    // 🔴 getBlogViewMap(전기간)을 쓰면 90일 창으로 정렬된 순위 옆에 다른 창의 숫자가 붙어
    //    "Top 5" 인데 1위가 4위보다 작은 화면이 된다(2026-08-07 리뷰에서 실제로 잡힌 결함).
    expect(src).toContain('fetchPopularSlugViews');
    expect(src).not.toContain('getBlogViewMap');
    expect(src, 'admin 이중 게이트 없음').toMatch(/role\s*!==\s*'admin'/);
  });

  it('홈 대시보드는 전기간 엔드포인트를 부르지 않는다', () => {
    const src = read('src/components/ProjectsDashboard.tsx');
    expect(src).toContain('/api/admin/popular-views');
    // 따옴표 종류·표기에 의존하지 않게 넓힌다 — fetch("…")·백틱도 잡아야 한다.
    expect(src).not.toMatch(/['"`]\/api\/admin\/blog['"`]/);
  });
});

describe('AI 가이드 챗봇 — 조회수 노출', () => {
  const payload = {
    profile: { name: '테스트', bio: '소개' } as unknown as SiteProfileData,
    projects: [],
    popularPosts: posts,
    postCount: 2,
  };

  it('canSeeViews 미지정(기본 비공개)이면 답변에 회수가 없다', () => {
    const reply = answerSiteQuestion('인기 블로그 글 알려줘', payload);
    expect(reply.answer).toContain('첫 번째 글');
    expect(reply.answer).not.toMatch(/12345회|\(\d+회\)/);
  });

  it('canSeeViews=false 도 동일하게 가린다', () => {
    const reply = answerSiteQuestion('인기 블로그 글 알려줘', { ...payload, canSeeViews: false });
    expect(reply.answer).not.toMatch(/\(\d+회\)/);
  });

  it('canSeeViews=true(관리자)면 회수를 싣는다', () => {
    const reply = answerSiteQuestion('인기 블로그 글 알려줘', { ...payload, canSeeViews: true });
    expect(reply.answer).toContain('(12345회)');
  });
});
