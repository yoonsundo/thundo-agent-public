/**
 * hub/query.mjs — CEO Q&A 응답기
 * 한국어 질문을 받아 실제 런 데이터·예산 기반으로만 답변한다.
 * 근거 없으면 정직하게 "모른다"고 한다 — 환각 금지.
 *
 * 지원 인텐트:
 *   budget  — 예산/비용/돈/토큰/한도/사용량
 *   discard — 폐기/실패/탈락/왜/이유
 *   publish — 발행/몇 편/게시/포스트
 *   status  — 상태/오늘/런/결과/요약
 *   none    — 매칭 없음 → 정직한 거절
 *
 * 설계 원칙:
 *   - 데이터 없으면 추측 없이 거절
 *   - 파일·필드 누락에도 throw 금지 (방어적 읽기)
 *   - STATE_DIR_OVERRIDE 로 테스트 격리 가능 (store 경유)
 *   - stdlib 전용, 외부 의존성 없음
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { paths, loadBudget } from '../lib/config.mjs';

// ─── 최신 런 로더 ─────────────────────────────────────────────────────────────
// briefing.mjs 에 의존하지 않고 자체 구현 (병렬 작성 충돌 방지)

/**
 * loadLatestRun() → { date, run, runBudget } | null
 * paths.runs 아래 YYYY-MM-DD 폴더 중 알파벳 내림차순 최신 하나를 선택.
 * run.json 과 budget.json 을 방어적으로 파싱.
 */
function loadLatestRun() {
  let entries;
  try {
    entries = readdirSync(paths.runs, { withFileTypes: true });
  } catch {
    return null;
  }

  const dateFolders = entries
    .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map(e => e.name)
    .sort()
    .reverse(); // 최신 날짜 우선

  if (!dateFolders.length) return null;

  const date = dateFolders[0];
  const runPath    = join(paths.runs, date, 'run.json');
  const budgetPath = join(paths.runs, date, 'budget.json');

  let run       = null;
  let runBudget = null;

  try {
    if (existsSync(runPath)) run = JSON.parse(readFileSync(runPath, 'utf8'));
  } catch {
    // 파일 손상 → null 유지
  }

  try {
    if (existsSync(budgetPath)) runBudget = JSON.parse(readFileSync(budgetPath, 'utf8'));
  } catch {
    // 파일 손상 → null 유지
  }

  return { date, run, runBudget };
}

// ─── 인텐트 정의 ──────────────────────────────────────────────────────────────

const INTENTS = [
  {
    name: 'budget',
    keywords: ['예산', '비용', '돈', '토큰', '한도', '얼마', '사용량', '소비', '잔여', '남았'],
  },
  {
    name: 'discard',
    keywords: ['폐기', '실패', '탈락', '왜', '이유', '거절', '떨어', '통과 못', '통과못', '안 됐', '안됐'],
  },
  {
    name: 'publish',
    keywords: ['발행', '출판', '몇 편', '몇편', '게시', '포스트', '올린', '올렸', '발행됐', '발행됐'],
  },
  {
    name: 'status',
    keywords: ['상태', '오늘', '요약', '어떻게 됐', '어떻게됐', '결과', '런 어때'],
  },
];

/** 질문에서 인텐트 이름을 반환. 매칭 없으면 'none'. */
function matchIntent(question) {
  for (const intent of INTENTS) {
    if (intent.keywords.some(kw => question.includes(kw))) {
      return intent.name;
    }
  }
  return 'none';
}

// ─── 인텐트별 응답 생성기 ─────────────────────────────────────────────────────

/** 예산/비용 질문 응답 */
function answerBudget(runData) {
  const cfg  = loadBudget();
  const cap  = cfg?.daily_hard_cap ?? {};
  const used = runData?.runBudget  ?? {};

  const capTokens = cap.tokens       ?? null;
  const capCalls  = cap.agent_calls  ?? null;
  const usedTokens = used.tokens_used ?? null;
  const usedCalls  = used.calls_used  ?? null;
  const date = runData?.date ?? '(날짜 미상)';

  // 핵심 데이터 중 하나도 없으면 거절
  if (capTokens === null && usedTokens === null) {
    return { answer: '예산 데이터(budget.json)를 읽을 수 없습니다.', basis: null };
  }

  const fmt = n => (typeof n === 'number' ? n.toLocaleString() : '(알 수 없음)');

  const answer =
    `일일 한도: 토큰 ${fmt(capTokens)}개 / 에이전트 호출 ${fmt(capCalls)}회. ` +
    `오늘(${date}) 사용: 토큰 ${fmt(usedTokens)}개, 호출 ${fmt(usedCalls)}회.`;

  return {
    answer,
    basis: {
      daily_hard_cap: cap,
      today_used: { tokens_used: usedTokens, calls_used: usedCalls },
      date,
    },
  };
}

/** 폐기/실패 질문 응답 */
function answerDiscard(runData) {
  const run = runData?.run;
  if (!run) {
    return { answer: '런 데이터를 찾을 수 없어 폐기 사유를 확인할 수 없습니다.', basis: null };
  }

  const discardedIds = new Set(run.discarded ?? []);
  const discardedDrafts = (run.drafts ?? []).filter(
    d => discardedIds.has(d.draft_id) || d.outcome === 'discarded'
  );

  if (!discardedDrafts.length) {
    return {
      answer: `${runData.date} 런에서 폐기된 초안이 없습니다.`,
      basis: { date: runData.date, discarded: [] },
    };
  }

  const details = discardedDrafts.map(d => {
    // 모든 시도의 실패 게이트 수집
    const failedGates = (d.attempts ?? []).flatMap(a =>
      (a.gate_gates ?? []).filter(g => !g.pass)
    );

    if (!failedGates.length) {
      return `• "${d.title}": 게이트 기록 없음 (검증자 단계 탈락 추정)`;
    }

    // 같은 게이트+사유 중복 제거
    const seen   = new Set();
    const unique = failedGates.filter(g => {
      const key = `${g.gate}:${g.reason}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const reasons = unique.map(g => `[${g.gate}] ${g.reason}`).join(' / ');
    return `• "${d.title}": ${reasons}`;
  });

  return {
    answer: `${runData.date} 런 폐기 초안 ${discardedDrafts.length}편:\n${details.join('\n')}`,
    basis: {
      date: runData.date,
      discarded: discardedDrafts.map(d => ({
        draft_id: d.draft_id,
        title: d.title,
        outcome: d.outcome,
        failed_gates: (d.attempts ?? []).flatMap(a =>
          (a.gate_gates ?? []).filter(g => !g.pass).map(g => ({ gate: g.gate, reason: g.reason }))
        ),
      })),
    },
  };
}

/** 발행 편수 질문 응답 */
function answerPublish(runData) {
  const run = runData?.run;
  if (!run) {
    return { answer: '런 데이터를 찾을 수 없어 발행 정보를 확인할 수 없습니다.', basis: null };
  }

  const published = run.published ?? [];
  const topics    = run.topics_selected ?? [];
  const discarded = (run.discarded ?? []).length;

  const answer =
    `${runData.date} 런: 주제 ${topics.length}개 선정 → ` +
    `${published.length}편 발행, ${discarded}편 폐기. ` +
    (published.length
      ? `발행 파일: ${published.join(', ')}`
      : '발행 없음.');

  return {
    answer,
    basis: { date: runData.date, published, topics_count: topics.length, discarded_count: discarded },
  };
}

/** 전체 상태 요약 응답 */
function answerStatus(runData) {
  const run = runData?.run;
  if (!run) {
    return { answer: '런 데이터를 찾을 수 없습니다.', basis: null };
  }

  const status    = run.status       ?? '(알 수 없음)';
  const published = (run.published   ?? []).length;
  const discarded = (run.discarded   ?? []).length;
  const topics    = (run.topics_selected ?? []).length;
  const elapsed   = typeof run.elapsed_ms === 'number'
    ? `${(run.elapsed_ms / 1000).toFixed(1)}초`
    : '(알 수 없음)';

  const answer =
    `${runData.date} 런 상태: ${status}. ` +
    `주제 ${topics}개 선정, 발행 ${published}편, 폐기 ${discarded}편. ` +
    `소요시간: ${elapsed}.`;

  return {
    answer,
    basis: { date: runData.date, status, published, discarded, topics, elapsed_ms: run.elapsed_ms },
  };
}

// ─── 공개 API ─────────────────────────────────────────────────────────────────

/**
 * answerQuery(question) → { answer: string, basis: object|null, matched: string }
 *
 * 한국어 질문을 키워드로 라우팅하고 실제 데이터 기반으로 답한다.
 * 근거 없으면 추측 없이 거절한다.
 * 순수 함수 — 영속화는 표면 레이어(message.ts·worker.mjs) 책임이다.
 *
 * @param {string} question - CEO 질문 (한국어)
 * @returns {{ answer: string, basis: object|null, matched: string }}
 */
export function answerQuery(question) {
  const matched = matchIntent(String(question ?? ''));

  let answer;
  let basis;

  if (matched === 'none') {
    answer = '그 질문은 현재 데이터로 답할 수 없습니다. (예산·폐기·발행·상태 관련 질문만 지원합니다.)';
    basis  = null;
  } else {
    const runData = loadLatestRun();

    let result;
    switch (matched) {
      case 'budget':  result = answerBudget(runData);  break;
      case 'discard': result = answerDiscard(runData); break;
      case 'publish': result = answerPublish(runData); break;
      case 'status':  result = answerStatus(runData);  break;
      default:
        result = { answer: '내부 오류: 알 수 없는 인텐트.', basis: null };
    }

    answer = result.answer;
    basis  = result.basis;
  }

  // 여기서 store 에 쓰면 표면 레이어(message.ts·worker.mjs)와 겹쳐 통합 store 에 중복 버블이 생긴다.
  return { answer, basis, matched };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('query.mjs')) {
  const question = process.argv[2];
  if (!question) {
    console.error('사용법: node query.mjs "질문"');
    process.exit(1);
  }

  const result = answerQuery(question);
  console.log(`\n[matched: ${result.matched}]`);
  console.log(result.answer);
  if (result.basis) {
    console.log('\n[근거 데이터]');
    console.log(JSON.stringify(result.basis, null, 2));
  }
}
