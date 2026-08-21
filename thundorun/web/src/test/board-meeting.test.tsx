/**
 * board-meeting.test.tsx — 경영회의 섹션의 표시 계약.
 *
 * 이 화면이 틀리면 생기는 일이 구체적이다:
 *   · 결론이 확정되지 않은 회의를 확정된 것처럼 보여주면, 아무것도 안 바뀐 날을 "정상"으로 읽는다.
 *   · `자가발전 큐`를 `반영됨`으로 읽으면, 아직 검사도 안 끝난 변경을 적용된 것으로 착각한다.
 * 그래서 이 둘을 픽셀이 아니라 **문구 계약**으로 고정한다.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import BoardMeeting from '@/components/BoardMeeting';
import type { BoardMeeting as Data } from '@/server/reports';

const base: Data = {
  date: '2026-08-21',
  held: null,
  leads: [
    { team: 'blog', lead: 'falcon', titles: ['CPO', 'CCO'], headline: '발행 3편', concerns: [], gaps: [] },
    { team: 'youtube', lead: 'dolphin', titles: ['CMO', 'CDO'], headline: '업로드 1편', concerns: [], gaps: ['조회수 자동수집 0건'] },
  ],
  rebuttal: {
    hidden_assumptions: [
      { point: '가정1', detail: '가정1의 근거' },
      { point: '가정2', detail: '가정2의 근거' },
      { point: '가정3', detail: '가정3의 근거' },
    ],
    risks: [
      { kind: 'technical', point: '위험1', detail: '기술 영향' },
      { kind: 'operational', point: '위험2', detail: '운영 영향' },
      { kind: 'organizational', point: '위험3', detail: '조직 영향' },
    ],
    logical_flaws: [{ point: '결함1', detail: '어디의 허점인지' }],
    overlooked_scenarios: [{ point: '시나리오1', detail: '' }, { point: '시나리오2', detail: '설명' }],
    preventive_measures: [{ point: '조치1', detail: '어떻게' }],
  },
  decisions: [
    { id: 'blog:P1', verdict: 'adopt', target: 'beaver', status: 'queued', reason: '자가발전 큐로' },
    { id: 'youtube:P1', verdict: 'adopt', target: 'dolphin', status: 'human', reason: '팀장 자기수정 불가' },
  ],
  needs_human: ['dolphin'],
};

describe('경영회의 표시', () => {
  it('데이터가 없으면 아무것도 그리지 않는다', () => {
    const { container } = render(<BoardMeeting board={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it('팀장과 겸직 직책이 보인다', () => {
    const { container } = render(<BoardMeeting board={base} />);
    // ⚠ 이름만으로 찾으면 안 된다 — 팀장 이름은 결정 표의 '대상' 칸에도 나온다(dolphin 이 그렇다).
    //   팀장 카드 안으로 범위를 좁혀야 "라인업에 있다"를 실제로 검사한 게 된다.
    const names = [...container.querySelectorAll('.card-quiet .card-title')].map((e) => e.textContent);
    expect(names).toEqual(['falcon', 'dolphin']);
    expect(screen.getByText(/CPO · CCO/)).toBeTruthy();
    expect(screen.getByText(/CMO · CDO/)).toBeTruthy();
  });

  it('CEO 반론 5종이 모두 표시된다', () => {
    render(<BoardMeeting board={base} />);
    for (const h of ['숨은 가정', '잠재적 위험', '논리적 결함', '간과된 시나리오', '예방 조치']) {
      expect(screen.getByText(h), `${h} 가 없다`).toBeTruthy();
    }
  });

  it('결론 미확정이면 경고가 뜨고 "변경 없음"이 명시된다', () => {
    render(<BoardMeeting board={{ ...base, held: '반론 형식 미달' }} />);
    expect(screen.getByText(/결론 미확정/)).toBeTruthy();
    expect(screen.getByText(/아무것도 변경하지 않았습니다/)).toBeTruthy();
  });

  it('확정된 회의엔 미확정 경고가 없다', () => {
    render(<BoardMeeting board={base} />);
    expect(screen.queryByText(/결론 미확정/)).toBeNull();
  });

  // 계약은 그대로다 — '아직 적용 전'과 '적용 완료'가 같은 말로 보이면 안 된다.
  // 라벨만 내부 용어(자가발전 큐)에서 사람 말로 바뀌었다.
  it('아직 적용 전인 항목이 "완료"로 보이지 않는다', () => {
    render(<BoardMeeting board={base} />);
    expect(screen.getByText('반영 준비됨')).toBeTruthy();
    expect(screen.queryByText('반영 완료')).toBeNull();
  });

  it('상태 라벨에 내부 용어를 쓰지 않는다', () => {
    const { container } = render(<BoardMeeting board={base} />);
    const labels = [...container.querySelectorAll('.tag')].map((e) => e.textContent ?? '');
    for (const bad of ['queued', 'human', '자가발전', '큐']) {
      expect(labels.some((l) => l.includes(bad)), `상태 라벨에 "${bad}" 가 남아 있다`).toBe(false);
    }
  });

  it('아직 적용 전임을 글로도 밝힌다', () => {
    render(<BoardMeeting board={base} />);
    expect(screen.getByText(/아직 적용 전/)).toBeTruthy();
  });

  it('내가 정해야 할 항목과 어디서 처리하는지 알린다', () => {
    render(<BoardMeeting board={base} />);
    expect(screen.getByText('내가 정해야 함')).toBeTruthy();
    // 갈 곳을 알려주지 않으면 예전처럼 "승인 필요"라고만 하고 끝나는 라벨이 된다.
    expect(screen.getByText(/승인함에서 읽고/)).toBeTruthy();
  });

  it('제안 내용이 대상 이름보다 먼저 읽힌다', () => {
    const withChange = {
      ...base,
      decisions: [{ ...base.decisions[0], change: '선정 기준에 다양성 벌점을 넣는다' }],
    };
    render(<BoardMeeting board={withChange} />);
    // 대상 이름만 보고는 무엇을 하자는 건지 알 수 없다 — 그게 표가 안 읽히던 근본 원인이었다.
    expect(screen.getByText('선정 기준에 다양성 벌점을 넣는다')).toBeTruthy();
  });

  it('계측 공백을 팀 카드에 노출한다', () => {
    render(<BoardMeeting board={base} />);
    expect(screen.getByText(/계측 공백 1건 — 조회수 자동수집 0건/)).toBeTruthy();
  });


  /**
   * 레이아웃 계약 — 디자이너 검토(2026-08-21) 결과를 고정한다.
   * 처음엔 카드 하나에 전부 담아 `.card-kicker` 가 한 화면에 10개 나왔다(위계 중복).
   * 무엇이 상위인지 사라지면 페이지가 "카드가 쌓이기만 하는" 상태가 된다.
   */
  it('세 블록으로 나뉘고 블록 제목은 셋뿐이다', () => {
    const { container } = render(<BoardMeeting board={base} />);
    const kickers = [...container.querySelectorAll('.card-kicker')].map((e) => e.textContent);
    expect(kickers).toEqual(['팀장 브리핑', '결정과 반영']);
    // CEO 블록은 카드가 아니라 아코디언이라 .card-kicker 를 쓰지 않는다.
    expect(container.querySelectorAll('.card').length).toBe(2);
    expect(container.querySelector('details.accordion')).toBeTruthy();
  });

  it('CEO 반론은 기본으로 접혀 있다', () => {
    const { container } = render(<BoardMeeting board={base} />);
    const acc = container.querySelector('details.accordion') as HTMLDetailsElement;
    expect(acc.open, '첫 화면부터 펼쳐져 있으면 페이지가 다시 무거워진다').toBe(false);
  });

  it('접힌 상태에서도 반론 건수는 보인다', () => {
    render(<BoardMeeting board={base} />);
    // 3 + 3 + 1 + 2 + 1 = 10
    expect(screen.getByText('반론 10건')).toBeTruthy();
  });

  it('반론 소제목은 블록 제목보다 낮은 위계를 쓴다', () => {
    const { container } = render(<BoardMeeting board={base} />);
    const inAccordion = [...container.querySelectorAll('.accordion-body .kicker')].map((e) => e.textContent);
    expect(inAccordion).toEqual(['숨은 가정', '잠재적 위험', '논리적 결함', '간과된 시나리오', '예방 조치']);
    // 반론 제목이 .card-kicker 로 올라오면 위계가 다시 평평해진다.
    expect(container.querySelectorAll('.accordion-body .card-kicker').length).toBe(0);
  });

  it('반론이 비면 아코디언 자체가 없다', () => {
    const { container } = render(<BoardMeeting board={{ ...base, rebuttal: null }} />);
    expect(container.querySelector('details.accordion')).toBeNull();
  });


  /**
   * 읽기 계약 — 실측(2026-08-21): 반론 한 건이 190~320자였고 30건이 쌓이니 벽이 됐다.
   * 요지 한 줄이 먼저 보이고 근거는 접혀 있어야 한다.
   */
  it('반론은 요지가 먼저 보이고 근거는 접혀 있다', () => {
    const { container } = render(<BoardMeeting board={base} />);
    const rows = [...container.querySelectorAll('.accordion-body .list-row')];
    const withDetail = rows.filter((r) => r.querySelector('details'));
    expect(withDetail.length, '근거가 있는 항목은 펼칠 수 있어야 한다').toBeGreaterThan(0);
    for (const d of withDetail) {
      expect((d.querySelector('details') as HTMLDetailsElement).open, '기본은 접힌 상태').toBe(false);
      expect(d.querySelector('summary')?.textContent).toBeTruthy();
    }
  });

  it('근거가 없으면 열 것이 없으므로 접기를 만들지 않는다', () => {
    const { container } = render(<BoardMeeting board={base} />);
    const rows = [...container.querySelectorAll('.accordion-body .list-row')];
    const noDetail = rows.filter((r) => r.textContent?.includes('시나리오1'));
    expect(noDetail[0]?.querySelector('details'), '빈 근거로 빈 펼침을 만들면 안 된다').toBeNull();
  });

  it('리스크 층위를 한국어 라벨로 보여준다', () => {
    render(<BoardMeeting board={base} />);
    for (const ko of ['기술', '운영', '조직']) expect(screen.getByText(ko)).toBeTruthy();
  });

  it('예전 문자열 형식 회의도 깨지지 않는다', () => {
    const legacy: Data = { ...base, rebuttal: { ...base.rebuttal!, logical_flaws: ['옛날 문자열 항목'] } };
    render(<BoardMeeting board={legacy} />);
    expect(screen.getByText('옛날 문자열 항목')).toBeTruthy();
  });

  it('제안이 없는 날도 깨지지 않는다', () => {
    render(<BoardMeeting board={{ ...base, decisions: [], needs_human: [] }} />);
    expect(screen.getByText('상정된 제안이 없습니다.')).toBeTruthy();
  });

  it('반론이 없어도(회의 실패) 렌더는 살아 있다', () => {
    render(<BoardMeeting board={{ ...base, rebuttal: null, held: 'claude 실패' }} />);
    expect(screen.getByText(/결론 미확정/)).toBeTruthy();
    expect(screen.getByText('falcon')).toBeTruthy();
  });
});
