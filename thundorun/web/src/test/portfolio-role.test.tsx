/**
 * portfolio-role.test.tsx — 카드의 "담당 역할" 강조 렌더 고정.
 *
 * 역할 줄은 회색 메타 한 줄(.card-meta)로 두면 요약문에 묻힌다. 라벨 섹션 + 강조 칩으로
 * 세운 결정을 여기서 잠근다 — 되돌아가면 이 테스트가 깨진다.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProjectCard, splitRole } from '@/components/PortfolioPreview';
import type { ProjectRow } from '@/server/projects';

function project(overrides: Partial<ProjectRow>): ProjectRow {
  return {
    id: 'sample',
    title: '샘플 프로젝트',
    period: '2026',
    role: '행정 시스템 백엔드 개발 · Oracle 최적화 · 운영/보안/배포',
    stack: ['Java'],
    description: '설명',
    highlights: [],
    link: null,
    sort_order: 1,
    pinned: false,
    pinned_at: null,
    detail: {
      summary: '요약',
      flow: [],
      personas: { hr: '인사용', field: '현업용', ceo: 'CEO용' },
    },
    ...overrides,
  };
}

describe('담당 역할 강조', () => {
  it('구분자로 끊어 항목 배열을 만든다', () => {
    expect(splitRole('A · B · C')).toEqual(['A', 'B', 'C']);
    // 구분자가 없으면 통문장 1개 — 억지로 쪼개지 않는다.
    expect(splitRole('운영/보안/배포만 담당')).toEqual(['운영/보안/배포만 담당']);
    expect(splitRole('  ·  A  ·  ')).toEqual(['A']);
    expect(splitRole('')).toEqual([]);
    expect(splitRole(undefined)).toEqual([]);
  });

  it('역할을 라벨 섹션 + 강조 칩으로 렌더한다', () => {
    render(<ProjectCard p={project({})} persona="hr" />);

    expect(screen.getByText('담당 역할')).toBeInTheDocument();

    for (const part of ['행정 시스템 백엔드 개발', 'Oracle 최적화', '운영/보안/배포']) {
      const chip = screen.getByText(part);
      expect(chip).toHaveClass('tag');
      // 강조색 칩 — 중립 칩(기술 스택)과 구분되어야 "강조"가 성립한다.
      expect(chip).toHaveClass('tag-accent');
    }

    // 기술 스택은 중립 칩으로 남아 대비가 유지된다.
    expect(screen.getByText('Java')).toHaveClass('tag-neutral');
  });

  it('회색 메타 한 줄로 되돌아가지 않는다', () => {
    const { container } = render(<ProjectCard p={project({})} persona="hr" />);
    expect(container.querySelector('.card-meta')).toBeNull();
  });

  it('역할이 비어 있으면 섹션 자체를 감춘다', () => {
    render(<ProjectCard p={project({ role: '' })} persona="hr" />);
    expect(screen.queryByText('담당 역할')).not.toBeInTheDocument();
  });
});
