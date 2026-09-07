/**
 * board-approval-list.test.tsx — 승인함이 **사람이 읽고 판단할 수 있는가**를 지킨다.
 *
 * 실측(2026-08-21 사용자 지적): 승인함이 "(제안 내용이 기록되지 않았습니다)" 를 제목으로 띄우고,
 * 그 아래에 `허용 목록에 없는 설정 키(pick.whatif_ratio)` 같은 내부 문자열을 그대로 보여줬다.
 * 판단 근거가 없는 걸 승인하라고 두는 것은 승인 절차가 없는 것보다 나쁘다.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import BoardApprovalList from '@/components/BoardApprovalList';
import type { BoardApproval } from '@/server/board-approvals';

const base: BoardApproval = {
  key: '2026-08-21:youtube:P2',
  date: '2026-08-21',
  proposal_id: 'youtube:P2',
  team: 'youtube',
  target: 'raccoon',
  target_type: 'agent',
  change: '소재 발굴에 도메인 상한을 넣는다',
  rationale: '최근 30편이 역사 47%로 쏠렸다',
  expected_effect: '한 분야가 절반을 넘지 않게 된다',
  value: null,
  hold_why: 'raccoon 의 글쓰기 지침을 바꾸는 일입니다. 자동으로 채점할 방법이 없어 자동 반영 대상이 아닙니다.',
  hold_need: '승인하시면 변경 지시로 확정되고, 사람이 반영합니다.',
  status: 'pending',
  comment: null, decided_by: null, decided_at: null, applied_at: null, apply_result: null,
  created_at: '2026-08-21T05:57:00Z',
};

describe('경영회의 승인함', () => {
  it('무엇을 바꾸자는 것인지가 제목이다', () => {
    const { container } = render(<BoardApprovalList items={[base]} />);
    expect(container.querySelector('.card-title')?.textContent).toBe('소재 발굴에 도메인 상한을 넣는다');
  });

  it('왜·달라지는 것을 함께 보여준다', () => {
    render(<BoardApprovalList items={[base]} />);
    expect(screen.getByText('최근 30편이 역사 47%로 쏠렸다')).toBeTruthy();
    expect(screen.getByText('한 분야가 절반을 넘지 않게 된다')).toBeTruthy();
  });

  it('승인하면 무슨 일이 생기는지 버튼 근처에서 알려준다', () => {
    render(<BoardApprovalList items={[base]} />);
    expect(screen.getByText(/변경 지시로 확정/)).toBeTruthy();
  });

  it('승인만 강조하고 거부는 조용하다 — 셋 다 빨강이면 기본 동작이 사라진다', () => {
    const { container } = render(<BoardApprovalList items={[base]} />);
    const primary = [...container.querySelectorAll('.btn-primary')].map((b) => b.textContent);
    expect(primary.length).toBe(1);
    expect(primary[0]).toContain('승인');
    expect(container.querySelector('.btn-danger'), '거부에 danger 를 쓰면 승인과 경쟁한다').toBeNull();
  });

  it('내부 용어를 화면에 그대로 내보내지 않는다', () => {
    const { container } = render(<BoardApprovalList items={[base]} />);
    const text = container.textContent ?? '';
    for (const bad of ['target_type', 'agent', 'config', 'pending', 'human']) {
      expect(text.includes(bad), `내부 용어 "${bad}" 가 화면에 있다`).toBe(false);
    }
  });

  /**
   * ⚠ `human_task` 는 나머지와 성격이 다르다 — 승인하면 기계가 반영하는 앞의 둘과 달리
   *    이쪽은 "할 일 확정"이고 실제 작업은 사람이 한다. 사이트 개선·코드 수정이 전부 이 부류라
   *    같은 '기타'로 뭉뚱그리면 승인 버튼이 무엇을 하는지 오해하게 된다.
   */
  it('사람이 할 일은 기계가 반영하는 항목과 다르게 보인다', () => {
    const ask: BoardApproval = { ...base, target_type: 'human_task', target: null, plan: null,
      change: '검색 노출이 0에 가깝다 — 사이트 구조를 손봐야 한다' };
    const { container } = render(<BoardApprovalList items={[ask]} />);
    const text = container.textContent ?? '';
    expect(text).toContain('사람이 할 일');
    expect(text, '내부 식별자가 새면 안 된다').not.toContain('human_task');
    expect(text, '대상·계획이 비어도 본문은 보여야 한다').toContain('사이트 구조를 손봐야');
  });

  it('결정된 항목은 버튼 대신 결과를 보여준다', () => {
    const done: BoardApproval = {
      ...base, status: 'approved', decided_at: '2026-08-21T06:00:00Z',
      decided_by: 'me@example.com', comment: '해보자',
    };
    const { container } = render(<BoardApprovalList items={[done]} />);
    expect(container.querySelector('.btn-primary'), '이미 처리된 항목에 승인 버튼이 남아 있다').toBeNull();
    expect(screen.getByText(/해보자/)).toBeTruthy();
  });

  it('할 일이 없으면 빈 상태를 보여준다', () => {
    render(<BoardApprovalList items={[]} />);
    expect(screen.getByText('결정할 항목이 없습니다')).toBeTruthy();
  });

  it('대기 건수를 알려준다', () => {
    render(<BoardApprovalList items={[base, { ...base, key: 'k2', status: 'approved' }]} />);
    expect(screen.getByText(/결정 대기 1건/)).toBeTruthy();
  });
});

/**
 * 제목 길이 안전장치 — 화면은 데이터가 규칙을 지킨다고 믿지 않는다.
 * 실측(2026-08-21): 팀장이 change 에 502자를 넣어 제목 자리가 통째로 문단이 됐다.
 * 프롬프트로 "40자 이내"를 요구했지만 그건 바람이지 보장이 아니다.
 */
describe('제목이 문단이 되지 않는다', () => {
  const LONG = 'raccoon 발굴 지침에 배치 내 도메인 상한을 넣되, 문구만으로 끝내지 않는다. '
    + '①프롬프트 주입: raccoon 호출 시 최근 30편의 도메인 분포를 실제 수치로 넣는다. '
    + '②결정론적 강제: 백로그 저장 단계에서 검증한다. ③미달 보충: 부족분만 다른 도메인으로 재발굴한다.';

  it('실제로 있었던 502자급 제안도 제목이 한 줄로 잘린다', () => {
    const { container } = render(<BoardApprovalList items={[{ ...base, change: LONG, plan: null }]} />);
    const title = container.querySelector('.card-title')?.textContent ?? '';
    expect(title.length, `제목이 ${title.length}자다 — 한 줄로 읽혀야 한다`).toBeLessThanOrEqual(62);
    expect(title).toContain('raccoon');
  });

  it('잘려 나간 뒷부분은 사라지지 않고 본문으로 내려간다', () => {
    render(<BoardApprovalList items={[{ ...base, change: LONG, plan: null }]} />);
    expect(screen.getByText(/어떻게 바꾸는지 자세히/)).toBeTruthy();
    expect(screen.getByText(/결정론적 강제/), '내용이 유실되면 안 된다').toBeTruthy();
  });

  it('짧은 요지는 그대로 제목이 되고 접힘이 생기지 않는다', () => {
    const { container } = render(<BoardApprovalList items={[{ ...base, change: '소재에 도메인 상한을 넣는다', plan: null }]} />);
    expect(container.querySelector('.card-title')?.textContent).toBe('소재에 도메인 상한을 넣는다');
    expect(container.querySelector('details')).toBeNull();
  });

  it('요지 + 실행계획이 나뉘어 오면 계획은 접어서 보여준다', () => {
    const { container } = render(<BoardApprovalList items={[
      { ...base, change: '소재에 도메인 상한을 넣는다', plan: '① 프롬프트 주입 ② 저장 단계 검증' },
    ]} />);
    expect(container.querySelector('.card-title')?.textContent).toBe('소재에 도메인 상한을 넣는다');
    expect(screen.getByText(/프롬프트 주입/)).toBeTruthy();
  });
});
