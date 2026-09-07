/**
 * quiz-board.test.tsx — 퀴즈 화면 동작과 위장 계약.
 *
 * 위장이 핵심 요구다. "흐리게 처리" 같은 건 글자가 읽히므로 위장이 아니다 —
 * 보스키를 누르면 문항이 DOM 에서 아예 사라져야 한다. 그걸 여기서 확인한다.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import QuizBoard from '@/components/QuizBoard';
import { QUESTIONS } from '@/lib/kboQuiz';

/** 화면에 떠 있는 문항 텍스트(있으면 반환). */
function visibleQuestion(container: HTMLElement): string | null {
  return container.querySelector('.card-title')?.textContent ?? null;
}

describe('퀴즈 진행', () => {
  it('첫 문항이 뜨고 선택지 4개가 버튼으로 나온다', () => {
    const { container } = render(<QuizBoard />);
    expect(visibleQuestion(container)).toBeTruthy();
    const choices = container.querySelectorAll('.list-row .btn');
    expect(choices.length).toBe(4);
  });

  it('고르기 전에는 정답 힌트가 없다', () => {
    const { container } = render(<QuizBoard />);
    expect(container.querySelector('.tag-success')).toBeNull();
    expect(container.querySelector('.tag-danger')).toBeNull();
  });

  it('고르면 정답 표시와 해설이 나온다', () => {
    const { container } = render(<QuizBoard />);
    fireEvent.click(container.querySelectorAll('.list-row .btn')[0]);
    expect(container.querySelector('.tag-success'), '정답 표시가 없다').toBeTruthy();
    // 해설은 문항 데이터의 explain 중 하나여야 한다(지어낸 문구가 아님).
    const meta = [...container.querySelectorAll('.card-meta')].map((e) => e.textContent ?? '').join(' ');
    expect(QUESTIONS.some((q) => meta.includes(q.explain))).toBe(true);
  });

  it('한 번 고르면 다시 못 고른다 — 점수를 여러 번 올릴 수 없다', () => {
    const { container } = render(<QuizBoard />);
    const btns = container.querySelectorAll<HTMLButtonElement>('.list-row .btn');
    fireEvent.click(btns[0]);
    for (const b of container.querySelectorAll<HTMLButtonElement>('.list-row .btn')) {
      expect(b.disabled).toBe(true);
    }
  });

  it('끝까지 풀면 결과와 등급이 나온다', () => {
    const { container } = render(<QuizBoard />);
    // 세션 문항 수가 바뀌어도 깨지지 않게 화면이 끝날 때까지 돈다(15 로 못 박았다가 30 으로 늘자 실패했다).
    for (let i = 0; i < 200; i++) {
      const choices = container.querySelectorAll<HTMLButtonElement>('.list-row .btn');
      if (!choices.length) break;
      fireEvent.click(choices[0]);
      const nextBtn = screen.getByRole('button', { name: /다음 항목|검토 마치기/ });
      fireEvent.click(nextBtn);
    }
    expect(screen.getByText('검토 결과')).toBeTruthy();
    expect(screen.getByRole('button', { name: /새 항목으로 다시/ })).toBeTruthy();
  });
});

describe('업무 위장', () => {
  /**
   * ⚠ 문항 본문까지 금칙어로 훑으면 '퍼펙트게임' 안의 '게임'에 걸린다.
   *   그 문항이 뽑히는 회차에만 실패해서 **무작위로 깨지는 테스트**가 된다(리뷰 지적).
   *   검사 대상은 우리가 쓴 UI 문구(제목·라벨·버튼)여야 한다 — 야구 용어는 통제 대상이 아니다.
   */
  it('UI 문구에 게임처럼 보이는 단어가 없다', () => {
    const { container } = render(<QuizBoard />);
    const chrome = [
      ...container.querySelectorAll('.page-title, .page-sub, .kicker, .card-kicker, .btn'),
    ].map((e) => e.textContent ?? '').join(' ');
    for (const word of ['퀴즈', '게임', '점수', '플레이', '레벨']) {
      expect(chrome.includes(word), `UI 문구에 "${word}" 가 보이면 위장이 깨진다`).toBe(false);
    }
  });

  it('Esc 를 누르면 문항이 DOM 에서 사라진다 — 흐리게가 아니라 제거', () => {
    const { container } = render(<QuizBoard />);
    const q = visibleQuestion(container);
    expect(q).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.getByText('분기 운영 점검 보고서')).toBeTruthy();
    expect(container.textContent).not.toContain(q as string);
    expect(container.querySelectorAll('.list-row .btn').length, '선택지가 남아 있다').toBe(0);
  });

  it('Esc 를 다시 누르면 돌아온다', () => {
    const { container } = render(<QuizBoard />);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(visibleQuestion(container)).toBeTruthy();
  });

  it('입력 칸 안에서 누른 Esc 는 가로채지 않는다', () => {
    const { container } = render(<QuizBoard />);
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(visibleQuestion(container), '입력 중 Esc 로 화면이 바뀌면 안 된다').toBeTruthy();
    input.remove();
  });

  it('위장 화면에도 되돌리는 방법이 적혀 있다', () => {
    render(<QuizBoard />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByText(/Esc 를 누르면 이전 화면으로/)).toBeTruthy();
  });
});
