import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import PipelineTree from '@/app/(site)/agents/PipelineTree';

describe('에이전트 소개 파이프라인 레이아웃', () => {
  it('네 개 운영팀을 데스크톱 2열 그리드에 배치한다', () => {
    const { container } = render(<PipelineTree />);
    const teamGrid = container.querySelector('.grid-2.grid-start');

    expect(teamGrid).toBeInTheDocument();
    expect(teamGrid?.children).toHaveLength(4);
    expect(screen.getByText('마케팅 팀 · 블로그 발행')).toBeInTheDocument();
    expect(screen.getByText('개발팀 · 홈페이지')).toBeInTheDocument();
    expect(screen.getByText('호기심 쇼츠 · 유튜브')).toBeInTheDocument();
    expect(screen.getByText('카드뉴스 · 인스타그램')).toBeInTheDocument();
  });

  it('모바일 세로 길이를 줄이도록 팀과 상시 지원을 접힌 native details로 시작한다', () => {
    const { container } = render(<PipelineTree />);
    const accordions = Array.from(container.querySelectorAll('details.accordion'));

    expect(accordions).toHaveLength(5);
    accordions.forEach((item) => expect(item).not.toHaveAttribute('open'));
    expect(screen.getByText('상시 지원 · 관제')).toBeInTheDocument();
    expect(screen.getByText(/4개 팀 · 필요한 흐름만 펼쳐서 확인/)).toBeInTheDocument();
    expect(
      screen.getByText(/팀 이름을 클릭하면 실제 업무 순서와 담당 에이전트가 단계별로 펼쳐집니다/),
    ).toBeInTheDocument();
    expect(screen.getByText(/에이전트 노드를 누르면 위 역할 카드로 바로 이동합니다/)).toBeInTheDocument();
  });

  it('접힌 상태에서도 팀 규모와 흐름 요약을 제공한다', () => {
    render(<PipelineTree />);

    expect(screen.getByText('수집부터 발행·감사까지 · 8단계')).toBeInTheDocument();
    expect(screen.getByText('요청부터 검증·배포까지 · 9단계')).toBeInTheDocument();
    expect(screen.getByText('아이디어부터 유튜브 발행까지 · 8단계')).toBeInTheDocument();
    expect(screen.getByText('소재부터 인스타 발행까지 · 9단계')).toBeInTheDocument();
  });
});
