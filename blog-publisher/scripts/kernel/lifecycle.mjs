/**
 * kernel/lifecycle.mjs — 콘텐츠 아이템 수명주기 상태기계 (순수함수)
 *
 * 왜 있는가(F-16): 세 버티컬이 **같은 개념**을 다루는데 표현이 전혀 달랐다.
 *
 *   cardnews         STATES 9종 + TRANSITIONS 표 + 불법 간선 throw   ← 가장 엄밀
 *   shorts-curiosity markStatus(id, status) — 자유 문자열, 검증 없음
 *   blog             published-index 배열 + run.json status 문자열
 *
 * cardnews 가 옳다. 인스타에 삭제 API 가 없다는 도메인 제약이 그 엄밀함을 강제했고,
 * 그래서 "발행 완료 후 다시 제작 중" 같은 불가능한 전이가 코드에서 막힌다.
 * 문제는 그 지식이 cardnews 안에 갇혀 있어서, **네 번째 버티컬을 만들면 네 번째 방언이
 * 생긴다**는 점이었다. 여기가 정본이다 — 상태 집합은 채널이 주입한다.
 *
 * 판정 로직과 문구는 cardnews 판 그대로다(바꾸면 그 채널의 전이 판정이 바뀐다).
 *
 * 커널 규약: fs·child_process·Date 를 import 하지 않는다.
 */

/**
 * 채널의 상태 집합·허용 간선으로 상태기계를 만든다.
 *
 * @param {object} spec
 * @param {readonly string[]} spec.states  가능한 상태 전부
 * @param {Object<string, readonly string[]>} spec.transitions  from → 허용 to 목록.
 *        시작 상태는 `null` 키로 적는다(아직 상태가 없는 아이템).
 * @param {readonly string[]} [spec.terminal] 종단 상태 — 오류 문구를 더 분명하게 만든다
 * @returns {{states, transitions, allowedTransitions, canTransition, isTerminal}}
 */
export function makeLifecycle({ states, transitions, terminal = [] }) {
  const STATES = Object.freeze([...states]);
  const TRANSITIONS = Object.freeze({ ...transitions });
  const TERMINAL = new Set(terminal);

  /** from 에서 갈 수 있는 상태들. 모르는 from 이면 null(= 판정 불가). */
  function allowedTransitions(from) {
    return TRANSITIONS[from === null || from === undefined ? 'null' : from] || null;
  }

  /**
   * 전이 가능 여부. 불허면 사유를 문장으로 돌려준다 —
   * "왜 막혔는지" 가 로그에 남지 않으면 운영자가 추적할 수 없다.
   */
  function canTransition(from, to) {
    const allowed = allowedTransitions(from);
    if (!allowed) return { ok: false, reason: `미지의 from 상태 '${from}'` };
    if (!STATES.includes(to)) return { ok: false, reason: `미지의 to 상태 '${to}'` };
    if (!allowed.includes(to)) {
      return {
        ok: false,
        reason: TERMINAL.has(from)
          ? `'${from}' 는 종단 상태 — 어떤 전이도 없다`
          : `'${from}' → '${to}' 불허(허용: ${allowed.join(', ') || '없음'})`
            + (from === to ? ' — 같은 상태에서 필드만 남기려면 flush() 를 쓰라' : ''),
      };
    }
    return { ok: true };
  }

  const isTerminal = (s) => TERMINAL.has(s);

  return { states: STATES, transitions: TRANSITIONS, allowedTransitions, canTransition, isTerminal };
}

/**
 * 블로그 초안의 수명주기 명세.
 *
 * 상태값은 `run-lion.mjs` 가 실제로 쓰는 `draftSummary.outcome` 에서 뽑았다 —
 * `published` · `discarded` · `discarded_slug` · `discarded_budget`.
 * 폐기 갈래를 하나로 뭉치지 않은 것은 의도다: slug 위반은 게이트 **앞**에서,
 * 예산 캡은 게이트를 **돌기도 전에** 걸린다. 사후에 "왜 안 나갔나" 를 가르는 축이다.
 *
 * ⚠ 이 표는 **초안 한 편의 런 내 생애**만 다룬다. 발행된 글이 `published/`·사이트·DB
 *   세 곳에 제대로 들어갔는지는 별개 축이고 `lib/blog-consistency.mjs` 가 본다.
 */
export const BLOG_STATES = Object.freeze([
  'drafted', 'gate_passed', 'published', 'discarded', 'discarded_slug', 'discarded_budget',
]);

export const BLOG_TRANSITIONS = Object.freeze({
  null:               ['drafted', 'discarded_slug', 'discarded_budget'],
  // slug 위반은 게이트·검증자 앞에서 걸러진다(재시도 낭비 방지) → drafted 를 거치지 않는다
  drafted:            ['gate_passed', 'drafted', 'discarded'],   // drafted→drafted = 재시도
  gate_passed:        ['published', 'drafted', 'discarded'],     // 검증자 미통과면 재시도
  published:          [],
  discarded:          [],
  discarded_slug:     [],
  discarded_budget:   [],
});

/** 블로그 수명주기 인스턴스. 종단은 발행·폐기 4종 전부. */
export const blogLifecycle = makeLifecycle({
  states: BLOG_STATES,
  transitions: BLOG_TRANSITIONS,
  terminal: ['published', 'discarded', 'discarded_slug', 'discarded_budget'],
});
