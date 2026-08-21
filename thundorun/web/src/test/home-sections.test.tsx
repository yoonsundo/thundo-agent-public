/**
 * home-sections.test.tsx — 홈 좌측 열 보강(최근 영상 · 에이전트 팀) 렌더 계약.
 *
 * 왜 테스트인가:
 *   이 두 섹션은 Supabase 데이터에 의존한다. 로컬 개발 환경엔 DB 크리덴셜이 없어
 *   `getActiveVideos()`/`getActiveAgents()` 가 빈 배열을 돌려주므로 **화면으로는 확인이 불가능**하다.
 *   그래서 렌더 로직을 여기서 잠근다 — 데이터가 있을 때 나오는지, 없을 때 안 나오는지 둘 다.
 *
 * 배경: 1440px 에서 좌측 열이 인기글 5개로 끝나 화면 절반이 비고, 우측 사이드바가 훨씬 길어
 * 좌우 높이가 크게 어긋나 있었다(2026-08-19 실측). 이 섹션들이 그 공백을 메운다.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import ProjectsDashboard, {
  type Profile,
  type Stat,
  type HomeVideo,
  type HomeAgent,
} from '@/components/ProjectsDashboard';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/' }));
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'unauthenticated' }),
}));

const profile: Profile = {
  name: 'Thundo',
  handle: 'thundo',
  title: '백엔드 개발자',
  bio: '',
  avatar: '/profile.png',
  skills: ['Next.js'],
  socials: [],
};
const stats: Stat[] = [{ label: '블로그 글', value: '10' }];

const videos: HomeVideo[] = [
  { youtube_id: 'v1', title: '바이킹 뿔투구 신화', youtube_url: 'https://youtu.be/v1', thumbnail_url: 'https://img/1.jpg' },
  { youtube_id: 'v2', title: '두 번째 영상', youtube_url: 'https://youtu.be/v2', thumbnail_url: null },
];
const agents: HomeAgent[] = [
  { id: 'lion', name: '라이언 (Lion)', role: '오케스트레이터' },
  { id: 'bee', name: '비 (Bee)', role: 'SEO 검증' },
];

function renderHome(v: HomeVideo[], a: HomeAgent[]) {
  return render(
    <ProjectsDashboard profile={profile} stats={stats} popularPosts={[]} videos={v} agents={a} />,
  );
}

beforeEach(() => {
  // useReveal 이 IntersectionObserver 를 쓴다 — jsdom 엔 없으므로 훅이 "즉시 표시"로 떨어진다.
  // 그 폴백이 실제로 동작하는지도 함께 확인한다(콘텐츠가 숨겨진 채 남으면 안 된다).
  vi.stubGlobal('IntersectionObserver', undefined);
});

describe('홈 — 최근 영상 섹션', () => {
  it('영상이 있으면 제목과 링크를 그린다', () => {
    renderHome(videos, []);
    expect(screen.getByText('최근 영상')).toBeInTheDocument();
    expect(screen.getByText('바이킹 뿔투구 신화')).toBeInTheDocument();
    const link = screen.getByText('바이킹 뿔투구 신화').closest('a');
    expect(link).toHaveAttribute('href', 'https://youtu.be/v1');
    // 외부 링크는 새 탭 + 보안 속성이 붙어야 한다.
    expect(link).toHaveAttribute('target', '_blank');
    expect(link?.getAttribute('rel')).toContain('noopener');
  });

  it('썸네일이 없는 영상도 제목은 남는다 (이미지 없다고 항목이 사라지면 안 된다)', () => {
    const { container } = renderHome(videos, []);
    expect(screen.getByText('두 번째 영상')).toBeInTheDocument();
    expect(container.querySelectorAll('.video-thumb')).toHaveLength(1); // 썸네일 있는 것만
  });

  it('영상이 없으면 섹션 자체를 그리지 않는다 (빈 카드가 공백을 만들면 안 된다)', () => {
    renderHome([], []);
    expect(screen.queryByText('최근 영상')).not.toBeInTheDocument();
  });
});

describe('홈 — 에이전트 팀 섹션', () => {
  it('에이전트가 있으면 이름·역할과 글자 아바타를 그린다', () => {
    const { container } = renderHome([], agents);
    expect(screen.getByText('에이전트 팀')).toBeInTheDocument();
    expect(screen.getByText('라이언 (Lion)')).toBeInTheDocument();
    expect(screen.getByText('오케스트레이터')).toBeInTheDocument();
    expect(container.querySelectorAll('.agent-chip')).toHaveLength(2);
  });

  it('에이전트가 없으면 섹션 자체를 그리지 않는다', () => {
    renderHome([], []);
    expect(screen.queryByText('에이전트 팀')).not.toBeInTheDocument();
  });
});

describe('홈 — 프로필 아바타', () => {
  it('사진이 아니라 이름 첫 글자를 그린다', () => {
    const { container } = renderHome([], []);
    const avatar = container.querySelector('aside .avatar-xl');
    expect(avatar?.textContent).toBe('T');
    // 스톡 사이트 캡처(`/profile.png`)가 다시 들어오면 여기서 걸린다.
    expect(container.querySelector('aside img')).toBeNull();
  });
});

describe('홈 — 모션이 콘텐츠를 가리지 않는다', () => {
  it('IntersectionObserver 가 없으면 .reveal 이 즉시 표시된다', () => {
    const { container } = renderHome(videos, agents);
    const hidden = container.querySelectorAll('.reveal:not(.is-in)');
    expect(
      hidden.length,
      '관찰자를 못 쓰는 환경에서 콘텐츠가 투명한 채 남는다 — 장식이 내용을 가리면 안 된다',
    ).toBe(0);
  });
});
