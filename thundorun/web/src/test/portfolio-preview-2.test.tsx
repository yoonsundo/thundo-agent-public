import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import PortfolioPreview2, {
  getPortfolioCategory,
  stripProjectTitleEmoji,
} from '@/components/PortfolioPreview2';
import type { ProjectRow } from '@/server/projects';

function project(overrides: Partial<ProjectRow>): ProjectRow {
  return {
    id: 'personal-sample',
    title: '개인 자동화 프로젝트',
    period: '2026',
    role: '설계 및 구현',
    stack: ['TypeScript'],
    description: '개인 프로젝트 설명',
    highlights: [],
    link: null,
    sort_order: 1,
    pinned: false,
    pinned_at: null,
    detail: {
      summary: '프로젝트 요약',
      flow: [],
      personas: {
        hr: '인사 담당자용 문장',
        field: '현업 담당자용 문장',
        ceo: 'CEO용 문장',
      },
    },
    ...overrides,
  };
}

describe('포트폴리오 미리보기 2', () => {
  it('명시 카테고리를 우선하고 기존 회사 프로젝트는 경력기술로 분류한다', () => {
    expect(getPortfolioCategory(project({ detail: {
      summary: '', flow: [], personas: { hr: '', field: '', ceo: '' }, category: 'career',
    } }))).toBe('career');
    expect(getPortfolioCategory(project({ id: 'ai-rag-platform' }))).toBe('career');
    expect(getPortfolioCategory(project({ id: 'side-project' }))).toBe('personal');
  });

  it('개인 프로젝트 제목에서 이모지를 제거한다', () => {
    expect(stripProjectTitleEmoji('🚀 개인 🧪 자동화 프로젝트')).toBe('개인 자동화 프로젝트');

    render(<PortfolioPreview2 projects={[
      project({ id: 'side-project', title: '🚀 개인 🧪 자동화 프로젝트' }),
    ]} />);

    expect(screen.getByText('개인 자동화 프로젝트')).toBeInTheDocument();
    expect(screen.queryByText(/🚀|🧪/)).not.toBeInTheDocument();
  });

  it('개인 프로젝트와 경력기술을 탭으로 전환한다', async () => {
    const user = userEvent.setup();
    render(<PortfolioPreview2 projects={[
      project({ id: 'side-project', title: '개인 프로젝트 항목' }),
      project({ id: 'ai-rag-platform', title: '회사 프로젝트 항목' }),
    ]} />);

    const personalTab = screen.getByRole('tab', { name: /개인 프로젝트/ });
    const careerTab = screen.getByRole('tab', { name: /경력기술/ });
    expect(personalTab).toHaveAttribute('aria-selected', 'true');
    expect(careerTab).toHaveAttribute('aria-selected', 'false');

    const personal = screen.getByRole('tabpanel', { name: /개인 프로젝트/ });
    expect(within(personal).getByText('개인 프로젝트 항목')).toBeInTheDocument();
    expect(within(personal).queryByText('회사 프로젝트 항목')).not.toBeInTheDocument();

    await user.click(careerTab);

    const career = screen.getByRole('tabpanel', { name: /경력기술/ });
    expect(careerTab).toHaveAttribute('aria-selected', 'true');
    expect(within(career).getByText('회사 프로젝트 항목')).toBeInTheDocument();
    expect(within(career).queryByText('개인 프로젝트 항목')).not.toBeInTheDocument();
  });

  it('관점 선택 탭 없이 현업 담당자 문장만 렌더링한다', () => {
    render(<PortfolioPreview2 projects={[project({})]} />);

    expect(screen.getByRole('tablist', { name: '프로젝트 분류' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /인사담당자|CEO/ })).not.toBeInTheDocument();
    expect(screen.getAllByText(/현업 담당자/).length).toBeGreaterThan(0);
    expect(screen.queryByText('인사 담당자용 문장')).not.toBeInTheDocument();
    expect(screen.queryByText('CEO용 문장')).not.toBeInTheDocument();
    expect(screen.queryByText(/아키텍처 결정, 구현 방식, 운영 경험/)).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: '개인 프로젝트 카드' })).not.toHaveClass('grid-start');
    // 카드가 .portfolio-card(§11.12 접힘 높이 통일)를 갖는지가 계약이다. 그리드 직속 자식인지는
    // 구현 세부 — 관리자 조작 줄이 붙으면서 카드가 래퍼 안으로 들어갔다.
    expect(
      screen.getByRole('group', { name: '개인 프로젝트 카드' }).querySelector('.portfolio-card'),
    ).not.toBeNull();
  });

  it('카드마다 관리자 수정·삭제 버튼을 렌더링한다', () => {
    render(<PortfolioPreview2 projects={[project({})]} />);

    expect(screen.getByRole('button', { name: '수정' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '삭제' })).toBeInTheDocument();
  });

  it('삭제 버튼은 곧바로 지우지 않고 확인 다이얼로그를 먼저 띄운다', async () => {
    const user = userEvent.setup();
    render(<PortfolioPreview2 projects={[project({ title: '지울 프로젝트' })]} />);

    await user.click(screen.getByRole('button', { name: '삭제' }));

    const dialog = screen.getByRole('dialog', { name: '프로젝트 삭제' });
    expect(within(dialog).getByText(/지울 프로젝트/)).toBeInTheDocument();
    expect(within(dialog).getByText(/되돌릴 수 없습니다/)).toBeInTheDocument();
  });

  it('수정 버튼은 ID 가 잠긴 편집 다이얼로그를 연다', async () => {
    const user = userEvent.setup();
    render(<PortfolioPreview2 projects={[project({ id: 'fixed-id' })]} />);

    await user.click(screen.getByRole('button', { name: '수정' }));

    const dialog = screen.getByRole('dialog', { name: '프로젝트 수정' });
    expect(within(dialog).getByLabelText(/ID/)).toBeDisabled();
    expect(within(dialog).getByLabelText(/ID/)).toHaveValue('fixed-id');
    expect(within(dialog).getByLabelText('분류')).toHaveValue('personal');
  });
});
