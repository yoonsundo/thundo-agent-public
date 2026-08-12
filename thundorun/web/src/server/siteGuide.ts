import type { SiteProfileData } from '@/server/siteProfile';
import type { ProjectRow } from '@/server/projects';
import type { PopularPost } from '@/components/ProjectsDashboard';

export interface SiteGuidePayload {
  profile: SiteProfileData;
  projects: ProjectRow[];
  popularPosts: PopularPost[];
  postCount: number;
  /**
   * 조회수 숫자를 답변에 실어도 되는가 — **관리자만 true.**
   * 기본은 false(비공개). 이 함수는 순수함수를 유지해야 하므로 세션을 직접 읽지 않고,
   * 호출측(라우트 핸들러)이 판정해 넘긴다.
   */
  canSeeViews?: boolean;
}

export interface SiteGuideReply {
  answer: string;
  suggestions: string[];
  sources: string[];
  /** 'fallback' = 어떤 분기에도 못 걸린 최종 안내 — sitechat_misses 기록 대상. 그 외엔 미설정. */
  kind?: 'fallback';
}

const DEFAULT_SUGGESTIONS = [
  '이 홈페이지는 어떤 사이트인가요?',
  '대표 프로젝트 3개만 소개해줘',
  '어떤 기술 스택을 주로 쓰나요?',
  '연락은 어디로 하면 되나요?',
];

function normalize(input: string) {
  return String(input || '').trim().toLowerCase();
}

function projectScore(project: ProjectRow, question: string) {
  const detail = project.detail;
  const hay = normalize([
    project.title,
    project.role,
    project.description,
    project.stack.join(' '),
    project.highlights.join(' '),
    // detail(jsonb) — 요약·처리흐름·관점별 설명·기술노트까지 검색 대상에 포함
    detail?.summary,
    ...(detail?.flow?.map((s) => `${s.label} ${s.desc}`) ?? []),
    detail?.personas?.hr,
    detail?.personas?.field,
    detail?.personas?.ceo,
    ...(detail?.tech ?? []),
  ].join(' '));

  if (!hay) return 0;

  let score = 0;
  if (hay.includes(question)) score += 5;

  const tokens = question.split(/\s+/).filter(t => t.length >= 2);
  for (const token of tokens) {
    if (hay.includes(token)) score += 2;
  }
  return score;
}

function projectLine(project: ProjectRow) {
  const stack = project.stack.slice(0, 4).join(', ');
  // 볼드 항목엔 제목만 — 기간·역할·설명·스택은 들여쓰기 상세줄(렌더 시 메타)로 분리
  const meta = [project.period, project.role].filter(Boolean).join(' · ');
  return [
    `- ${project.title}`,
    meta ? `  ${meta}` : '',
    `  ${project.description}`,
    stack ? `  스택: ${stack}` : '',
    project.link ? `  링크: ${project.link}` : '',
  ].filter(Boolean).join('\n');
}

/** 상세 질문용 — 포트폴리오 미리보기(detail: summary·flow·tech)와 같은 내용을 답변으로. */
function projectDetailAnswer(project: ProjectRow): string {
  const d = project.detail;
  const meta = [project.period, project.role].filter(Boolean).join(' · ');
  const lines: string[] = [`${project.title} — 상세 설명입니다.`];
  if (meta) lines.push(meta);
  lines.push('', d?.summary || project.description);

  if (d?.personas?.field) {
    lines.push('', `실무 관점: ${d.personas.field}`);
  }
  if (d?.flow?.length) {
    lines.push('', '진행 흐름:');
    for (const step of d.flow) {
      lines.push(`- ${step.label}`, `  ${step.desc}`);
    }
  }
  if (d?.tech?.length) {
    lines.push('', '기술 노트:');
    for (const note of d.tech) lines.push(`- ${note}`);
  }
  if (project.stack.length) lines.push('', `스택: ${project.stack.join(', ')}`);
  if (project.link) lines.push(`링크: ${project.link}`);
  return lines.join('\n');
}

function topProjects(projects: ProjectRow[], count = 3) {
  return projects
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .slice(0, count);
}

export function answerSiteQuestion(questionRaw: string, payload: SiteGuidePayload): SiteGuideReply {
  const question = normalize(questionRaw);
  const { profile, projects, popularPosts, postCount, canSeeViews = false } = payload;
  const sources = new Set<string>();

  if (!question) {
    return {
      answer: `${profile.name}의 홈페이지입니다. ${profile.bio} 궁금한 건 프로젝트, 기술 스택, 블로그, 연락 방법 위주로 물어보면 바로 정리해드릴 수 있습니다.`,
      suggestions: DEFAULT_SUGGESTIONS,
      sources: ['site_profile'],
    };
  }

  const contactHit = /(연락|문의|이메일|메일|깃허브|github|contact|email|링크)/.test(question);
  // '이력' 단독은 제외(기존 projectHit 소유), '프로젝트/포트폴리오' 동반 시 프로젝트 경로 유지.
  const careerHit = /(경력|커리어|연혁|career|근무|이력서|어디서 일)/.test(question)
    && !/(프로젝트|포트폴리오)/.test(question);
  const skillsHit = /(기술|스택|skill|typescript|node|react|next|supabase|vercel|자동화)/.test(question);
  const blogHit = /(블로그|글|포스팅|콘텐츠|blog)/.test(question);
  const projectHit = /(프로젝트|포트폴리오|작업|대표작|만든 것|이력|경력|resume|portfolio)/.test(question);
  const introHit = /(누구|소개|무엇|뭐하는|어떤 사이트|홈페이지|about|프로필)/.test(question);
  const availHit = /(협업|채용|의뢰|가능|available|location|지역|어디)/.test(question);

  const rankedProjects = projects
    .map(project => ({ project, score: projectScore(project, question) }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(entry => entry.project);

  if (contactHit) {
    sources.add('site_profile');
    const socialLines = profile.socials
      .map(s => `- ${s.label}: ${s.href}`)
      .join('\n');
    return {
      answer: `연락 창구는 프로필 링크에 정리돼 있습니다.\n${socialLines || '- 공개된 연락 링크 없음'}${profile.available ? '\n현재 프로필상 협업 가능 상태로 표시돼 있습니다.' : ''}`,
      suggestions: ['어떤 프로젝트를 했는지 알려줘', '기술 스택을 요약해줘'],
      sources: [...sources],
    };
  }

  // 경력 질문은 프로젝트 목록이 아니라 연혁으로 답한다 (projectHit 의 '이력|경력' 보다 먼저).
  if (careerHit && Array.isArray(profile.career) && profile.career.length > 0) {
    sources.add('site_profile');
    const lines = profile.career
      .map(c => `- ${c.period ? `${c.period} · ` : ''}${c.title}\n  ${c.summary}`)
      .join('\n');
    return {
      answer: `${profile.name}의 경력 연혁입니다(최신순).\n${lines}`,
      suggestions: ['대표 프로젝트 3개만 소개해줘', '기술 스택을 요약해줘'],
      sources: [...sources],
    };
  }

  // 상세 요청 + 특정 프로젝트 매칭 → 포트폴리오 미리보기(detail) 수준 심층 답변.
  // skillsHit 보다 먼저 — "RAG 기술 자세히 설명해줘" 는 스택 나열이 아니라 해당 프로젝트 상세가 맞다.
  const detailHit = /(상세|자세|설명해|깊게|더 알려|detail)/.test(question);
  if (detailHit && rankedProjects.length > 0) {
    sources.add('projects');
    return {
      answer: projectDetailAnswer(rankedProjects[0]),
      suggestions: ['다른 프로젝트도 상세히 설명해줘', '기술 스택을 요약해줘'],
      sources: [...sources],
    };
  }

  if (skillsHit) {
    sources.add('site_profile');
    const stack = profile.skills.join(', ');
    return {
      answer: `${profile.name}의 현재 공개 주력 스택은 ${stack} 입니다. 프로필 타이틀은 "${profile.title}"이고, 소개 문구상 관심사는 웹·자동화·생산성 쪽입니다.`,
      suggestions: ['자동화 관련 대표 프로젝트는?', '블로그에서는 주로 무엇을 다루나요?'],
      sources: [...sources],
    };
  }

  if (rankedProjects.length > 0) {
    sources.add('projects');
    return {
      answer: `질문과 가장 가까운 프로젝트는 아래입니다.\n${rankedProjects.map(projectLine).join('\n')}`,
      suggestions: ['대표 프로젝트 3개만 다시 요약해줘', '이 사람은 어떤 문제를 주로 해결하나요?'],
      sources: [...sources],
    };
  }

  if (projectHit) {
    sources.add('projects');
    const featured = topProjects(projects, 3);
    return {
      answer: `${profile.name}의 공개 포트폴리오에서 먼저 볼 만한 대표 프로젝트 3개입니다.\n${featured.map(projectLine).join('\n')}`,
      suggestions: ['기술 스택을 요약해줘', '블로그에서는 어떤 글이 인기인가요?'],
      sources: [...sources],
    };
  }

  if (blogHit) {
    sources.add('popular_posts');
    const top = popularPosts.slice(0, 3);
    const summary = top.length
      ? top.map((post, i) =>
          // 조회수는 관리자에게만 — 비관리자에겐 순위와 제목만 남긴다.
          canSeeViews && typeof post.views === 'number'
            ? `- ${i + 1}. ${post.title} (${post.views}회)`
            : `- ${i + 1}. ${post.title}`,
        ).join('\n')
      : '- 아직 집계된 인기글 데이터가 없습니다.';
    return {
      answer: `현재 홈페이지에는 블로그 글 ${postCount}편이 연결돼 있습니다. 최근 인기글 기준으로 보면:\n${summary}`,
      suggestions: ['대표 프로젝트도 소개해줘', '이 홈페이지는 무엇을 하는 곳인가요?'],
      sources: [...sources],
    };
  }

  if (availHit) {
    sources.add('site_profile');
    return {
      answer: `${profile.name}의 공개 프로필 기준 위치는 ${profile.location || '미기재'}이고, 협업 상태는 ${profile.available ? '가능' : '미표시'}입니다.`,
      suggestions: ['연락 링크를 알려줘', '어떤 프로젝트를 했는지 알려줘'],
      sources: [...sources],
    };
  }

  if (introHit) {
    sources.add('site_profile');
    sources.add('projects');
    return {
      answer: `이 홈페이지는 ${profile.name}의 작업물 허브입니다. ${profile.bio}\n\n공개된 정보 기준으로는 ${profile.title} 포지션에 가깝고, 대표 포트폴리오는 자동화 파이프라인·AI 에이전트 운영·콘텐츠/도구 제작 쪽입니다. 프로젝트 ${projects.length}개와 블로그 글 ${postCount}편이 연결돼 있어 소개, 작업 이력, 인기 글을 한 곳에서 볼 수 있습니다.`,
      suggestions: DEFAULT_SUGGESTIONS,
      sources: [...sources],
    };
  }

  sources.add('site_profile');
  sources.add('projects');
  return {
    answer: `질문을 더 좁혀주면 더 정확히 정리할 수 있습니다. 지금 바로 답할 수 있는 범위는 홈페이지 소개, 대표 프로젝트, 기술 스택, 경력, 블로그, 연락 방법입니다.\n\n현재 공개 정보 기준으로 이 사이트는 ${profile.name}의 포트폴리오 허브이고, 프로젝트 ${projects.length}개와 블로그 글 ${postCount}편이 연결돼 있습니다.`,
    suggestions: DEFAULT_SUGGESTIONS,
    sources: [...sources],
    kind: 'fallback',
  };
}
