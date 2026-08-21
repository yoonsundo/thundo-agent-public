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

    // 4개 팀 + 상시 지원 + 경영회의(2026-08-21 신설) = 6
    expect(accordions).toHaveLength(6);
    accordions.forEach((item) => expect(item).not.toHaveAttribute('open'));
    expect(screen.getByText('상시 지원 · 관제')).toBeInTheDocument();
    expect(screen.getByText(/경영회의 1 · 4개 팀 · 필요한 흐름만 펼쳐서 확인/)).toBeInTheDocument();
    expect(
      screen.getByText(/팀 이름을 클릭하면 실제 업무 순서와 담당 에이전트가 단계별로 펼쳐집니다/),
    ).toBeInTheDocument();
    expect(screen.getByText(/에이전트 노드를 누르면 위 역할 카드로 바로 이동합니다/)).toBeInTheDocument();
  });

  it('접힌 상태에서도 팀 규모와 흐름 요약을 제공한다', () => {
    render(<PipelineTree />);

    expect(screen.getByText('수집부터 발행·감사까지 · 8단계 · 팀장 팰컨')).toBeInTheDocument();
    expect(screen.getByText('요청부터 검증·배포까지 · 9단계 · 팀장 라이노')).toBeInTheDocument();
    expect(screen.getByText('아이디어부터 유튜브 발행까지 · 8단계 · 팀장 돌핀')).toBeInTheDocument();
    expect(screen.getByText('소재부터 인스타 발행까지 · 9단계 · 팀장 팬서')).toBeInTheDocument();
  });

  /**
   * 경영회의 계층 — 팀장은 파이프라인을 **실행하지 않는다.** 매일 CEO에게 브리핑하고 전략을
   * 제안하는 자리다. 팀 실행 흐름 안에 끼워 넣으면 "팀장을 거쳐야 글이 나간다"는 잘못된 그림이 된다.
   */
  it('경영회의 계층이 팀 그리드와 분리돼 있다', () => {
    const { container } = render(<PipelineTree />);
    expect(screen.getByText('경영회의 · 매일 09:20')).toBeInTheDocument();
    expect(screen.getByText('CEO 1인 · 팀장 4인 · 브리핑과 반론')).toBeInTheDocument();

    // 팀 그리드는 여전히 4칸이어야 한다 — 경영회의가 팀처럼 섞여 들어가면 안 된다.
    expect(container.querySelector('.grid-2.grid-start')?.children).toHaveLength(4);
  });

  it('팀장 4인이 각자 담당 직책과 함께 나온다', () => {
    render(<PipelineTree />);
    for (const [name, role] of [
      ['팰컨', '블로그팀장 · CPO'], ['돌핀', '유튜브팀장 · CMO'],
      ['라이노', '개발팀장 · CTO'], ['팬서', '인스타팀장 · CBO'],
    ]) {
      expect(screen.getByText(name), `${name} 가 조직도에 없다`).toBeInTheDocument();
      expect(screen.getByText(role), `${name} 의 직책이 없다`).toBeInTheDocument();
    }
  });
});
