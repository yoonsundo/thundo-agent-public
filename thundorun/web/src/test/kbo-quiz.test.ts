/**
 * kbo-quiz.test.ts — 퀴즈 데이터 무결성.
 *
 * 정답 인덱스가 하나만 어긋나도 "맞는 답을 골랐는데 틀렸다"가 된다. 사람이 눈으로 훑어
 * 확인할 수 있는 종류가 아니라 여기서 기계적으로 잠근다.
 */
import { describe, it, expect } from 'vitest';
import { QUESTIONS, GRADES, LEVELS, gradeFor, shuffleChoices, buildQuiz } from '@/lib/kboQuiz';

describe('퀴즈 문항 데이터', () => {
  it('문항이 충분하다 (30분 분량)', () => {
    expect(QUESTIONS.length).toBeGreaterThanOrEqual(20);
  });

  it('id 가 중복되지 않는다', () => {
    const ids = QUESTIONS.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('정답 인덱스가 선택지 범위 안에 있다', () => {
    for (const q of QUESTIONS) {
      expect(q.answer, `${q.id}: 정답 인덱스가 범위를 벗어남`).toBeGreaterThanOrEqual(0);
      expect(q.answer, `${q.id}: 정답 인덱스가 범위를 벗어남`).toBeLessThan(q.choices.length);
    }
  });

  it('선택지가 4개이고 서로 다르다', () => {
    for (const q of QUESTIONS) {
      expect(q.choices.length, `${q.id}: 선택지 개수`).toBe(4);
      expect(new Set(q.choices).size, `${q.id}: 선택지 중복`).toBe(4);
    }
  });

  it('모든 문항에 질문·해설이 채워져 있다', () => {
    for (const q of QUESTIONS) {
      expect(q.question.trim().length, `${q.id}: 질문 비어 있음`).toBeGreaterThan(5);
      expect(q.explain.trim().length, `${q.id}: 해설 비어 있음`).toBeGreaterThan(5);
      expect(q.label.trim().length, `${q.id}: 위장 라벨 비어 있음`).toBeGreaterThan(1);
    }
  });

  it('네 단계가 모두 채워져 있다 (어린이→초딩→중딩→고딩)', () => {
    for (const lv of LEVELS) {
      expect(QUESTIONS.filter((q) => q.difficulty === lv).length, `${lv} 단계가 비었다`)
        .toBeGreaterThan(0);
    }
  });

  it('앞 두 단계가 과반이다 — "어린아이도 맞출 수준"이 요구였다', () => {
    const easy = QUESTIONS.filter((q) => q.difficulty === 'kid' || q.difficulty === 'elem').length;
    expect(easy / QUESTIONS.length).toBeGreaterThan(0.5);
  });

  it('LG 트윈스 팬심 문항이 들어 있다', () => {
    expect(QUESTIONS.filter((q) => q.id.startsWith('lg-')).length).toBeGreaterThanOrEqual(5);
  });

  /**
   * 🔴 시간이 지나면 틀린 답이 되는 문제를 넣지 않는다.
   * 2026 시즌은 진행 중이라 순위·승수는 매일 바뀐다. 그런 걸 문제로 내면 다음 주에 오답이 된다.
   */
  it('진행 중인 시즌의 순위·성적을 묻지 않는다', () => {
    const volatile = /현재 (순위|1위)|지금 (몇 위|1위)|올 시즌 (승률|승수)|몇 승/;
    for (const q of QUESTIONS) {
      expect(volatile.test(q.question), `${q.id}: 곧 낡을 문제다 — ${q.question}`).toBe(false);
    }
  });

  /**
   * 순위만 낡는 게 아니다. 구장·연고지·계약처럼 **바뀔 예정이 있는 사실**을 현재형으로 물으면
   * 그 시점에 오답이 된다. 실측: LG·두산은 2027~2031 잠실주경기장으로 이전이 확정돼 있어
   * "잠실을 같이 쓰는 두 팀은?"이 2027년에 틀린 문제가 된다(리뷰 지적).
   * → 이런 문항은 연도를 못 박아야 한다.
   */
  it('바뀔 예정인 사실은 연도를 못 박는다', () => {
    const needsYear = /함께 (홈으로 )?(쓴|쓰는|사용)|같이 쓰는/;
    for (const q of QUESTIONS) {
      if (!needsYear.test(q.question)) continue;
      expect(/\d{4}년/.test(q.question), `${q.id}: 연도 없이 물으면 언젠가 틀린다 — ${q.question}`)
        .toBe(true);
    }
  });
});

describe('팬심 등급', () => {
  it('구간이 내림차순이라 위에서부터 찾는 방식이 성립한다', () => {
    const mins = GRADES.map((g) => g.min);
    expect([...mins].sort((a, b) => b - a)).toEqual(mins);
  });

  it('맨 아래 구간이 0 이라 어떤 점수도 등급을 받는다', () => {
    expect(GRADES[GRADES.length - 1].min).toBe(0);
  });

  it('만점과 0점 모두 등급이 나온다', () => {
    expect(gradeFor(22, 22).title).toBeTruthy();
    expect(gradeFor(0, 22).title).toBeTruthy();
  });

  it('점수가 높을수록 위 등급이다', () => {
    const top = gradeFor(22, 22);
    const bottom = gradeFor(0, 22);
    expect(top.title).not.toBe(bottom.title);
    expect(GRADES.findIndex((g) => g.title === top.title))
      .toBeLessThan(GRADES.findIndex((g) => g.title === bottom.title));
  });

  it('총문항 0 이어도 죽지 않는다', () => {
    expect(gradeFor(0, 0).title).toBeTruthy();
  });
});

describe('출제 순서 섞기', () => {
  it('섞어도 정답이 따라간다 — 전 문항 전수 확인', () => {
    // 고정 시드 대신 여러 번 돌려 흔들리는 경우를 잡는다.
    for (let round = 0; round < 50; round++) {
      for (const q of QUESTIONS) {
        const s = shuffleChoices(q);
        expect(s.shuffled[s.shuffledAnswer], `${q.id}: 섞은 뒤 정답이 어긋났다`)
          .toBe(q.choices[q.answer]);
      }
    }
  });

  it('선택지가 사라지거나 늘지 않는다', () => {
    for (const q of QUESTIONS) {
      const s = shuffleChoices(q);
      expect([...s.shuffled].sort()).toEqual([...q.choices].sort());
    }
  });

  it('문항 수를 제한할 수 있다', () => {
    expect(buildQuiz(Math.random, 5)).toHaveLength(5);
    expect(buildQuiz()).toHaveLength(QUESTIONS.length);
  });

  it('출제 세트에도 문항 중복이 없다', () => {
    const ids = buildQuiz().map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('실제로 순서가 바뀐다 (항상 원본 그대로면 섞는 의미가 없다)', () => {
    const orders = new Set(
      Array.from({ length: 30 }, () => buildQuiz().map((q) => q.id).join(',')),
    );
    expect(orders.size, '30번 돌렸는데 순서가 한 가지뿐이다').toBeGreaterThan(1);
  });

  it('rand 를 주입하면 순서가 재현된다', () => {
    const fixed = () => 0.42;
    expect(buildQuiz(fixed).map((q) => q.id)).toEqual(buildQuiz(fixed).map((q) => q.id));
  });
});

describe('셔플 — 중복 선택지에도 정답이 어긋나지 않는다', () => {
  /**
   * 문자열을 indexOf 로 찾는 방식은 같은 선택지가 두 개면 첫 번째를 가리켜 정답이 어긋난다.
   * 지금 데이터에는 중복이 없지만, 문항을 추가하는 사람이 그 규칙을 몰라도 안전해야 한다.
   */
  const dup = {
    id: 'dup', label: 'x', question: 'q', difficulty: 'kid' as const, explain: 'e',
    choices: ['같은값', 'B', '같은값', 'C'],
    answer: 2,   // 두 번째 '같은값'이 정답
  };

  it('중복 문자열이 있어도 정답 위치가 정확하다', () => {
    for (let i = 0; i < 200; i++) {
      const s = shuffleChoices(dup);
      // 정답 자리의 값이 맞고, 그 자리가 원래 answer 가 옮겨간 자리여야 한다.
      expect(s.shuffled[s.shuffledAnswer]).toBe('같은값');
      // 중복이 사라지지 않았는지도 확인 — 한쪽만 남으면 문항이 바뀐 것이다.
      expect(s.shuffled.filter((c) => c === '같은값')).toHaveLength(2);
    }
  });

  it('정답이 첫 번째 중복에 고정되지 않는다', () => {
    const positions = new Set(
      Array.from({ length: 200 }, () => shuffleChoices(dup).shuffledAnswer),
    );
    expect(positions.size, '정답 위치가 한 곳으로 고정됐다 — indexOf 방식의 증상').toBeGreaterThan(1);
  });
});

describe('출제 순서 — 쉬운 것부터', () => {
  it('앞쪽에 어려운 단계가 끼어들지 않는다', () => {
    const rank = Object.fromEntries(LEVELS.map((l, i) => [l, i]));
    for (let round = 0; round < 20; round++) {
      const set = buildQuiz();
      const seq = set.map((q) => rank[q.difficulty]);
      expect([...seq].sort((a, b) => a - b), '단계가 뒤섞였다').toEqual(seq);
    }
  });

  it('첫 문항은 항상 가장 쉬운 단계다', () => {
    for (let i = 0; i < 20; i++) expect(buildQuiz()[0].difficulty).toBe('kid');
  });
});
