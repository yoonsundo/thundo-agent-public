/**
 * site-guide-career.test.ts — Stage A 동작 고정 (사이트챗 회귀)
 *
 * 1) '경력은 뭐야?' → 프로젝트 목록이 아니라 경력 연혁으로 답한다 (careerHit 가 projectHit 보다 먼저)
 * 2) '이 사람은 누구인가요?' → introHit 프로필 소개 (기존 동작 유지)
 * 3) 어떤 분기에도 안 걸리는 질문 → kind='fallback' (sitechat_misses 기록 대상 표시)
 * 4) projectScore 가 projects.detail(personas·tech)을 검색 대상에 포함한다
 */
import { describe, it, expect } from 'vitest';
import { answerSiteQuestion, type SiteGuidePayload } from '@/server/siteGuide';
import type { SiteProfileData } from '@/server/siteProfile';
import type { ProjectRow } from '@/server/projects';

const profile: SiteProfileData = {
  name: 'Thundo',
  handle: 'thundo',
  title: '백엔드 개발자',
  bio: '테스트 소개.',
  avatar: '/profile.png',
  skills: ['Java'],
  socials: [],
  career: [
    { period: '2024 ~ 현재', title: 'AI 플랫폼', summary: 'RAG 구축' },
    { period: '2019 ~ 2024', title: '대학 정보시스템', summary: '행정 업무 개발' },
  ],
};

const project: ProjectRow = {
  id: 'p1',
  title: '모니터링 시스템',
  period: '2024',
  role: '',
  stack: ['Python'],
  description: '공공기관 모니터링.',
  highlights: [],
  link: null,
  sort_order: 1,
  pinned: false,
  pinned_at: null,
  detail: {
    summary: '크롤링 자동화 요약',
    flow: [{ label: '수집', desc: '게시물 감지' }],
    personas: { hr: '', field: '슈퍼셋대시보드 운영 경험', ceo: '' },
    tech: ['Streamlit'],
  },
};

const payload: SiteGuidePayload = {
  profile,
  projects: [project],
  popularPosts: [],
  postCount: 0,
};

describe('answerSiteQuestion — Stage A', () => {
  it("'경력은 뭐야?' 는 연혁으로 답한다", () => {
    const r = answerSiteQuestion('경력은 뭐야?', payload);
    expect(r.answer).toContain('경력 연혁');
    expect(r.answer).toContain('2019 ~ 2024');
    expect(r.kind).not.toBe('fallback');
  });

  it("career 가 비어 있으면 '경력' 질문은 기존 projectHit 경로로 남는다", () => {
    const r = answerSiteQuestion('경력은 뭐야?', {
      ...payload,
      profile: { ...profile, career: [] },
    });
    expect(r.answer).not.toContain('경력 연혁');
  });

  it("'이 사람은 누구인가요?' 는 프로필 소개로 답한다", () => {
    const r = answerSiteQuestion('이 사람은 누구인가요?', payload);
    expect(r.answer).toContain('테스트 소개.');
    expect(r.kind).not.toBe('fallback');
  });

  it('어느 분기에도 안 걸리면 kind=fallback', () => {
    const r = answerSiteQuestion('오늘 날씨 어때', payload);
    expect(r.kind).toBe('fallback');
  });

  it("'프로젝트 이력 보여줘' 는 연혁이 아니라 프로젝트 경로로 남는다", () => {
    const r = answerSiteQuestion('프로젝트 이력 보여줘', payload);
    expect(r.answer).not.toContain('경력 연혁');
  });

  it("'이력서 좀 보여줘' 는 연혁으로 답한다", () => {
    const r = answerSiteQuestion('이력서 좀 보여줘', payload);
    expect(r.answer).toContain('경력 연혁');
  });

  it('detail 안에만 있는 키워드로도 프로젝트가 검색된다', () => {
    const r = answerSiteQuestion('슈퍼셋대시보드 경험 있어?', payload);
    expect(r.answer).toContain('모니터링 시스템');
  });

  it('detail 이 없는 프로젝트도 스코어링이 깨지지 않는다', () => {
    const bare: ProjectRow = { ...project, detail: null };
    const r = answerSiteQuestion('모니터링 시스템 알려줘', {
      ...payload,
      projects: [bare],
    });
    expect(r.answer).toContain('모니터링 시스템');
  });

  it('목록 답변은 볼드 항목에 제목만 두고 기간·역할은 상세줄로 내린다', () => {
    const r = answerSiteQuestion('모니터링 시스템 알려줘', payload);
    expect(r.answer).toContain('- 모니터링 시스템\n  2024');
    expect(r.answer).not.toContain('- 모니터링 시스템 (2024)');
  });

  it('상세 질문은 포트폴리오 미리보기 내용(summary·실무관점·flow·tech)으로 답한다', () => {
    const r = answerSiteQuestion('모니터링 시스템 상세하게 설명해줘', payload);
    expect(r.answer).toContain('상세 설명입니다');
    expect(r.answer).toContain('크롤링 자동화 요약');
    expect(r.answer).toContain('실무 관점: 슈퍼셋대시보드');
    expect(r.answer).toContain('- 수집\n  게시물 감지');
    expect(r.answer).toContain('기술 노트:');
    expect(r.answer).toContain('Streamlit');
  });

  it('상세 질문인데 detail 이 없으면 description 기반으로 같은 구조 답변', () => {
    const bare: ProjectRow = { ...project, detail: null };
    const r = answerSiteQuestion('모니터링 시스템 상세하게 설명해줘', {
      ...payload,
      projects: [bare],
    });
    expect(r.answer).toContain('상세 설명입니다');
    expect(r.answer).toContain('공공기관 모니터링.');
    expect(r.answer).not.toContain('진행 흐름:');
  });

  it('상세 의도가 없으면 기존 목록 답변 유지', () => {
    const r = answerSiteQuestion('모니터링 시스템 알려줘', payload);
    expect(r.answer).toContain('질문과 가장 가까운 프로젝트는');
    expect(r.answer).not.toContain('상세 설명입니다');
  });
});
