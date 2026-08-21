'use client';

import Link from 'next/link';
import AgentAvatar from '@/components/ui/AgentAvatar';
import { usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { BookOpen, Link2, Mail, MapPin } from 'lucide-react';
import { useEffect, useState } from 'react';
import { navItemsFor } from '@/lib/nav';
import Empty from '@/components/state/Empty';
import { useReveal } from '@/hooks/useReveal';

export interface Stat {
  label: string;
  value: string;
  hint?: string;
}

export interface Social {
  label: string;
  href: string;
  icon: 'github' | 'mail' | 'blog' | 'link';
}

export interface Profile {
  name: string;
  handle: string;
  title: string;
  bio: string;
  avatar: string;
  location?: string;
  available?: boolean;
  skills: string[];
  socials: Social[];
}

export interface PopularPost {
  slug: string;
  title: string;
  date: string;
  /**
   * 조회수 — **관리자에게만 채워진다.**
   *
   * 홈은 ISR(revalidate=300)이라 캐시된 HTML 을 전 방문자가 공유한다. 서버에서 세션을 보고
   * 분기하면 홈 전체가 동적 렌더링으로 강등되므로, 서버는 숫자를 아예 넘기지 않고(undefined)
   * 관리자일 때만 이 컴포넌트가 클라이언트에서 받아 채운다. 순서(인기 순위)는 서버가 이미
   * 조회수로 정렬해 넘기므로 숫자가 없어도 유지된다.
   */
  views?: number;
}

/** 홈 좌측 열을 채우는 최근 영상(유튜브 쇼츠). 서버가 이미 활성분만 걸러 넘긴다. */
export interface HomeVideo {
  youtube_id: string;
  title: string;
  youtube_url: string;
  thumbnail_url: string | null;
}

/** 홈 좌측 열의 에이전트 팀 미리보기. 전체 목록은 `/agents` 에 있다. */
export interface HomeAgent {
  id: string;
  name: string;
  role: string;
  /** DB agents.image_url — 아바타의 단일 출처. 관리자에서 바꾸면 여기도 함께 바뀐다. */
  image_url?: string | null;
}

interface Props {
  profile: Profile;
  stats: Stat[];
  popularPosts: PopularPost[];
  videos: HomeVideo[];
  agents: HomeAgent[];
}

/**
 * 관리자에게만 slug→조회수 맵을 받아온다. 비관리자면 요청 자체를 보내지 않는다.
 *
 * 서버가 홈 페이로드에서 숫자를 뺀 뒤(ISR 캐시 공유 때문) 관리자에게만 되돌려 주는 경로다.
 * `/api/admin/**` 는 미들웨어 + 핸들러 이중으로 admin 을 강제하므로, 비관리자가 이 훅을
 * 우회 호출해도 401 만 받는다 — 화면 조건은 편의이고 실제 방어선은 서버다.
 *
 * 🔴 `/api/admin/blog`(날짜 필터 없는 전기간 누적) 가 아니라 `/api/admin/popular-views`
 *    (홈 순위를 만든 것과 같은 90일 창) 를 부른다. 창이 다르면 "Top 5" 순서와 숫자가
 *    어긋나 1위가 4위보다 작은 화면이 나온다(리뷰 지적, 2026-08-07).
 */
function useAdminBlogViews(isAdmin: boolean): Record<string, number> | null {
  const [fetched, setFetched] = useState<Record<string, number> | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    let alive = true;
    fetch('/api/admin/popular-views')
      .then((r) => (r.ok ? r.json() : null))
      .then((map: Record<string, number> | null) => {
        if (alive && map && typeof map === 'object') setFetched(map);
      })
      .catch(() => { /* 조회수는 부가 정보다 — 실패해도 인기글 목록은 그대로 보인다. */ });
    return () => { alive = false; };
  }, [isAdmin]);

  // 로그아웃 전이는 effect 에서 상태를 되돌리는 대신 **읽는 시점에 파생**한다.
  // 되돌리기 방식은 effect 안 setState(불필요한 연쇄 렌더)를 만들고, 되돌리기 전 한 프레임
  // 동안 이전 관리자 값이 남는다. 파생은 둘 다 없앤다.
  return isAdmin ? fetched : null;
}

function SocialIcon({ icon }: { icon: Social['icon'] }) {
  if (icon === 'mail') return <Mail size={16} aria-hidden />;
  if (icon === 'blog') return <BookOpen size={16} aria-hidden />;
  if (icon === 'link') return <Link2 size={16} aria-hidden />;
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.1-1.47-1.1-1.47-.9-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.89 1.52 2.34 1.08 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" />
    </svg>
  );
}

export default function ProjectsDashboard({ profile, stats, popularPosts, videos, agents }: Props) {
  const { data: session, status } = useSession();
  const isLoggedIn = status === 'authenticated';
  const isAdmin = session?.user?.role === 'admin';
  const adminViews = useAdminBlogViews(isAdmin);
  const pathname = usePathname();
  const navItems = navItemsFor({ isLoggedIn, isAdmin });
  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));
  const viewsFmt = new Intl.NumberFormat('ko-KR');

  // 스크롤 진입 — 섹션 개수가 바뀌면 대상도 다시 잡는다.
  useReveal([videos.length, agents.length, popularPosts.length]);

  return (
    <div className="container" style={{ paddingBlock: 'var(--space-8)' }}>
      <div className="page-head">
        <div>
          <p className="kicker">대시보드</p>
          <h1 className="page-title">{profile.name}</h1>
          <p className="page-sub">{profile.title}</p>
        </div>
        <div className="page-actions">
          <Link className="btn btn-primary" href="/blog">블로그 보기</Link>
        </div>
      </div>

      {/* 지표 4칸은 `.grid-3` 이 아니라 `.grid-auto` 를 쓴다(DESIGN.md §11.1).
          키트 `.grid-2/3/4` 는 900px 이하에서 **1열로 붕괴**해 폰에서 카드 4장이
          세로로 길게 쌓인다(iPhone 13 실측). auto-fit 은 최소폭(150px)이 허용하는 만큼
          채우므로 좁은 화면에서도 2열을 유지하고 넓은 화면에선 한 줄로 모인다. */}
      <div className="grid-auto">
        {stats.map((stat) => (
          <div className="stat reveal" key={stat.label}>
            <span className="stat-label">{stat.label}</span>
            <span className="stat-value">{stat.value}</span>
            {stat.hint && <span className="card-meta">{stat.hint}</span>}
          </div>
        ))}
      </div>

      <hr className="hr" />

      <div className="grid-sidebar">
        <div className="stack-6">
          {/* 소개 문단·대표 프로젝트 카드 제거(2026-08-06) → 그 자리의 방문자 Q&A 도
              메인에서 내림(2026-08-07 사용자 결정). 화면은 /admin/site-guide 에만 있다.
              컴포넌트와 /api/site-chat 은 그대로 살아 있으므로 되돌리려면 여기 한 줄이면 된다. */}
          <div className="card reveal">
            <div className="section-head">
              <h4>인기 블로그</h4>
              <div className="spacer" />
              <span className="text-muted">조회수 Top {popularPosts.length || 5}</span>
            </div>

            {popularPosts.length === 0 ? (
              <Empty
                title="아직 집계된 조회수가 없습니다"
                body="글이 읽히기 시작하면 조회수 순으로 여기에 모입니다."
                action={<Link className="btn btn-secondary" href="/blog">블로그 전체 보기</Link>}
              />
            ) : (
              <div className="list">
                {popularPosts.map((post, i) => (
                  <Link key={post.slug} href={`/blog/${post.slug}`} className="list-row card-link">
                    <span className="text-mono text-muted" style={{ width: 20 }}>{i + 1}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="card-title">{post.title}</div>
                      {post.date && <div className="card-meta">{post.date}</div>}
                    </div>
                    {/* 관리자에게만 붙는 조회수 칩. 비관리자에겐 이 노드 자체가 없다. */}
                    {(() => {
                      const v = post.views ?? adminViews?.[post.slug];
                      return typeof v === 'number'
                        ? <span className="tag tag-neutral text-mono">{viewsFmt.format(v)} 회</span>
                        : null;
                    })()}
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* 최근 영상 — 좌측 열이 인기글 5개로 끝나 화면 절반이 비어 있었다(1440px 실측).
              우측 사이드바(프로필+메뉴+기술스택)가 훨씬 길어 좌우 높이가 크게 어긋났다.
              이미 있는 데이터를 끌어와 채운다. 없으면 섹션 자체를 렌더하지 않는다. */}
          {videos.length > 0 && (
            <div className="card reveal">
              <div className="section-head">
                <h4>최근 영상</h4>
                <div className="spacer" />
                <Link className="text-muted" href="/videos">전체 보기</Link>
              </div>
              <div className="grid-auto">
                {videos.map((v) => (
                  <a
                    key={v.youtube_id}
                    className="card-link stack-2"
                    href={v.youtube_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {v.thumbnail_url && (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        src={v.thumbnail_url}
                        alt=""
                        loading="lazy"
                        className="video-thumb"
                      />
                    )}
                    <span className="card-title">{v.title}</span>
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* 에이전트 팀 미리보기 — 이 사이트의 정체성이 '에이전트가 굴리는 파이프라인'인데
              홈에서 그 존재가 전혀 안 보였다. 전체 소개는 /agents 에 있다. */}
          {agents.length > 0 && (
            <div className="card card-quiet reveal">
              <div className="section-head">
                <h4>에이전트 팀</h4>
                <div className="spacer" />
                <Link className="text-muted" href="/agents">전체 보기</Link>
              </div>
              <div className="agent-grid">
                {agents.map((a) => (
                  <div className="agent-chip" key={a.id}>
                    <AgentAvatar id={a.id} name={a.name} imageUrl={a.image_url} sizeClass="" />
                    <span className="text-ellipsis">
                      <span className="card-title">{a.name}</span>
                      <span className="card-meta">{a.role}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <aside className="stack-6">
          <div className="card">
            {/* 글자 아바타 — 에이전트 소개 화면과 같은 방식(`avatar-neutral` + 이름 첫 글자).
                기존 `/profile.png` 은 스톡 사이트 화면 캡처라 투명 격자·워터마크·뒤로가기 버튼·
                마우스 커서가 그대로 구워져 있었다(2026-08-19 확인). 사이트 전체가 이미 글자
                아바타를 쓰므로 이쪽이 일관되고 라이선스 문제도 없다. */}
            <span className="avatar avatar-xl avatar-neutral" aria-hidden="true">
              {profile.name.slice(0, 1)}
            </span>

            <div className="stack-2">
              <span className="card-title">{profile.name}</span>
              <span className="text-mono text-muted">@{profile.handle}</span>
              <p className="card-body">{profile.title}</p>
            </div>

            {/* 배지는 내용만큼만 차지해야 한다 — `.card` 가 flex 열이라 그냥 두면
                자식이 교차축으로 늘어나 사이드바 전체 폭을 먹는다(실측). */}
            {profile.available && (
              <div className="row">
                <span className="tag tag-success">협업 가능</span>
              </div>
            )}

            {profile.location && (
              <div className="card-meta">
                <MapPin size={16} aria-hidden />
                {profile.location}
              </div>
            )}

            <hr className="hr" />

            <nav className="stack-2" aria-label="사이트 메뉴">
              {navItems.map((item) => {
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="nav-item"
                    aria-current={isActive(item.href) ? 'page' : undefined}
                  >
                    <Icon size={16} aria-hidden />
                    {item.label}
                  </Link>
                );
              })}
            </nav>

            <hr className="hr" />

            <div className="row" style={{ flexWrap: 'wrap' }}>
              {profile.socials.map((s) => (
                <a
                  key={s.label}
                  className="btn btn-icon tooltip"
                  href={s.href}
                  aria-label={s.label}
                  data-tip={s.label}
                  target={s.href.startsWith('http') ? '_blank' : undefined}
                  rel="noopener noreferrer"
                >
                  <SocialIcon icon={s.icon} />
                </a>
              ))}
            </div>
          </div>

          {/* 부수 정보는 눕힌다 — 카드가 전부 흰색으로 뜨면 위계가 다시 사라진다. */}
          <div className="card card-quiet">
            <span className="card-title">기술 스택</span>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {profile.skills.map((skill) => (
                <span className="tag tag-neutral" key={skill}>{skill}</span>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
