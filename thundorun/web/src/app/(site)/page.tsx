import ProjectsDashboard from '@/components/ProjectsDashboard';
import NoticeBanner from '@/components/NoticeBanner';
import { getPostSummaries } from '@/lib/blog';
import { getProfile } from '@/server/siteProfile';
import { fetchPopularSlugViews, joinPopularPosts, toPublicPopularPosts } from '@/server/popularPosts';
import { getPinnedNotices } from '@/server/notices';
import { SHOW_NOTICES } from '@/lib/featureFlags';
import { getProjects } from '@/server/projects';
import type { Profile, Stat } from '@/components/ProjectsDashboard';

// ISR 5분 캐시 — 홈은 요청별 입력(쿠키·쿼리)이 없어 정적 재검증으로 충분.
export const revalidate = 300;

export const metadata = {
  title: '홈',
  description: 'AI 도구 · 자동화 · 생산성 — Thundo 홈',
};

export default async function HomeLandingPage() {
  const [posts, dbProfile, pinnedNotices, popularSlugViews, projects] = await Promise.all([
    getPostSummaries(),
    getProfile(),
    getPinnedNotices(),
    fetchPopularSlugViews(),
    getProjects(),
  ]);
  const postCount = posts.length;

  const profile: Profile = {
    name: dbProfile.name,
    handle: dbProfile.handle,
    title: dbProfile.title,
    bio: dbProfile.bio,
    avatar: dbProfile.avatar,
    location: dbProfile.location,
    available: dbProfile.available,
    skills: dbProfile.skills,
    socials: dbProfile.socials,
  };

  // 조회수를 뺀 공개 형태로 넘긴다 — 홈은 ISR 이라 세션별 분기가 불가능하다.
  // 이유와 인라인 map 을 쓰면 안 되는 근거는 toPublicPopularPosts 정의부에 있다.
  // 관리자는 ProjectsDashboard 가 클라이언트에서 따로 받아 채운다.
  const popularPosts = toPublicPopularPosts(joinPopularPosts(popularSlugViews, posts, 5));

  const stats: Stat[] = [
    { label: '블로그 글', value: String(postCount), hint: '발행됨' },
    { label: '프로젝트', value: String(projects.length), hint: '공개됨' },
    { label: '기술 스택', value: String(profile.skills.length), hint: '주력' },
    { label: '활동', value: '2026~', hint: '현재' },
  ];

  return (
    <>
      {SHOW_NOTICES && (
        <NoticeBanner notices={pinnedNotices.map((n) => ({ id: n.id, title: n.title }))} />
      )}
      <ProjectsDashboard
        profile={profile}
        stats={stats}
        popularPosts={popularPosts}
      />
    </>
  );
}
