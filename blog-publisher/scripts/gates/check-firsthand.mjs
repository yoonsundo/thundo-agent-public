#!/usr/bin/env node
/**
 * check-firsthand.mjs — 조작된 1인칭 실행 주장 게이트 (게이트 17)
 *
 * 왜 필요한가:
 *   초안을 쓰는 에이전트(beaver·fox·wolf)의 도구는 **Read·Write 뿐**이다. 도구를 설치할 수도,
 *   벤치마크를 돌릴 수도, 시간을 잴 수도 없다. 그런데 "제가 직접 돌려봤더니 48초" 같은 문장이
 *   실제로 발행됐다 — 203편 중 상당수다. 이건 문체 문제가 아니라 **없는 사실을 지어낸 것**이고,
 *   구글 2026-08 스팸 업데이트가 정확히 겨냥하는 프로필이다.
 *
 *   더 나쁜 것은 이 조작이 **규칙으로 강제됐다**는 점이다. 인용세탁(검증 불가 외부 통계)을 막으려고
 *   넣은 "외부 통계 대신 1인칭 경험·관찰로 대체하라"가, 실행할 수 없는 존재에게 실행 주장을
 *   요구하는 규칙이 됐다. 지시문(llm-writer.mjs·작가 정의 3종)은 같은 작업에서 함께 고쳤고,
 *   이 게이트는 그 지시문이 다시 흔들려도 산출물이 새어 나가지 않게 하는 최종 방어선이다.
 *
 * 입력: argv[2] = 초안 .md 절대경로
 * 출력: stdout JSON 1줄
 * exit: 0=통과 / 1=실패 / 2=실행오류
 *
 * 판정 규칙:
 *   claim_count >= CLAIM_THRESHOLD(1) → fail
 *   그 외 → pass
 *
 *   임계가 1인 이유: 헤징·밀도처럼 "정도"의 문제가 아니다. 실행하지 못하는 주체의 실행 주장은
 *   한 문장이라도 거짓이다. 비율 임계를 두면 "몇 개까지는 지어내도 된다"가 된다.
 *
 * ⚠ 막는 것과 막지 않는 것:
 *   막는다 — 실행·측정·소유를 완료형으로 주장하는 1인칭 표현
 *            ("제가 직접 돌려봤더니", "측정해보니", "제 노트북에서", "실측한 결과")
 *   막지 않는다 — 의견·판단 ("제가 보기엔", "제 생각엔", "저는 ~라고 봅니다")
 *                 독자 권유 ("직접 써보세요", "직접 써봐야 알 수 있습니다")
 *                 부인 ("직접 써보진 못했습니다", "저도 직접 쓰진 않아서")
 *                 출처 귀속 ("공식 문서 기준 48초", "논문이 돌린 결과")
 *   과차단은 매일 발행 0편을 뜻하므로, 애매한 표현은 통과 쪽으로 둔다.
 *
 * 알려진 한계(의도적으로 안 잡는 것):
 *   - "설치했습니다 / 설정했습니다" 같은 how-to 서술형 과거는 잡지 않는다. 실습 가이드의 단계
 *     설명과 실행 주장이 문자 수준에서 구분되지 않아, 잡으면 how-to 글이 통째로 막힌다.
 *   - "확인해보니"도 제외했다. 작가가 실제로 할 수 있는 행위(source_pack 발췌 Read)와 겹친다.
 *   이 둘은 게이트가 아니라 지시문·검증자(eagle)가 맡는다.
 *
 * 캘리브레이션 (2026-09-07 실측):
 *   - published/ 203편 → 111편 fail / 92편 pass. 전량 차단(과차단)도, 전량 통과(무력)도 아니다.
 *   - benchmark/negative 의 bad-06-fake-expertise(가짜 전문성 부정앵커)가 잡힌다 — 판별력 확인.
 *   - ⚠ benchmark/seed 33편 중 21편도 잡힌다. 이 앵커들은 "1인칭 경험 필수" 규칙 아래 만들어져
 *     조작 표현을 정상으로 취급하던 시절의 산물이다. 자가발전 fitness 앵커로 쓰이므로,
 *     앵커 재작성 여부는 별도 판단이 필요하다(이번 작업 범위 밖 — published/ 정정도 마찬가지).
 *   - 오탐 점검은 위반 260건의 문맥을 눈으로 훑어 했고, 거기서 나온 정상 문장 두 종류
 *     ("직접 비교는 어렵다" 부사적 용법, "직접 테스트할 기회가 생기면" 미래 가정)을
 *     패턴에서 제외했다. 회귀는 scripts/test/firsthand-gate.test.mjs [b] 블록이 지킨다.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { runGateCli, GateError } from './lib/gate-cli.mjs';
import { isMainModule } from '../lib/main-module.mjs';

// ─── 임계값 ────────────────────────────────────────────────────────────────────

/** 이 개수 이상의 실행 주장이 있으면 FAIL. 1 = 한 건도 허용하지 않는다. */
export const CLAIM_THRESHOLD = 1;

// ─── 패턴 ─────────────────────────────────────────────────────────────────────

/**
 * 완료형 어미. "했다"는 뜻이 문자에 박혀 있는 형태만 모았다.
 *   봤 / 보니 / 본 결과 / 봤더니
 * 명령형(보세요·보십시오)·권유형(봐야)·미래형(볼 예정)은 이 목록에 없으므로
 * **구조적으로** 매칭되지 않는다 — 별도 예외 처리가 필요 없다.
 */
const DONE = '(?:봤|보니|본\\s*결과|봤더니)';

/**
 * 실행 동사 어간 — 작가가 도구 없이는 할 수 없는 행위만 골랐다.
 * (읽기·생각하기 같은 작가가 실제로 하는 행위는 넣지 않는다.)
 */
const EXEC_STEMS = [
  '돌려',       // 돌려봤 / 돌려보니
  '써',         // 써봤 / 써보니
  '사용해',
  '테스트해',
  '측정해',
  '실행해',
  '설치해',
  '비교해',
  '실험해',
  '벤치마크해',
  '백테스트해',
  '학습시켜',
  '구축해',
  '배포해',
  '재현해',
  '세어',       // 세어봤 (횟수를 셌다 = 관측 주장)
  '재',         // 재봤 / 재보니 (시간을 쟀다)
];

/** 1인칭 실행·측정 주장 패턴. */
const CLAIM_PATTERNS = [
  // 1인칭 직접 수행 선언
  /제가\s*직접/g,
  // 조사를 **필수**로 둔다. `저?` 로 두면 "먼저 직접 확인하세요" 의 '먼저' 끝음절이 걸려
  // 독자 권유문을 조작으로 오판한다(코퍼스엔 아직 없지만 얼마든지 나올 문형이다).
  /저(?:는|도|희)\s*직접/g,
  // 어간 자체가 동사인 것들 — "직접 써본", "직접 돌려봤"
  /직접\s*(?:돌려|써|사용해|만들어)/g,
  // 명사+하다 형 — **하다가 활용된 형태일 때만** 잡는다.
  //   "직접 설치하고 비교했습니다" → 잡는다
  //   "직접 비교는 어렵다"(부사적 용법·실측 아님) → 안 잡는다
  //   "직접 테스트할 기회가 생기면"(미래 가정) → 안 잡는다(한글은 음절이 미리 조합돼 '할'≠'하')
  /직접\s*(?:테스트|측정|실행|설치|비교|구축|배포|구현|개발)(?=\s*(?:했|해|하고|하며|하니|한|합))/g,
  // 실행 결과 서술
  /돌린\s*결과/g,
  /실측(?:한|했|해봤|해보니|\s*결과|\s*기준)/g,
  // 어간 × 완료형 (아래 루프에서 생성)
  ...EXEC_STEMS.map(stem => new RegExp(`${stem}\\s*${DONE}`, 'g')),
];

/**
 * 소유 장비·환경 주장.
 * 수치의 근거로 "내 기계"를 대는 순간, 그 수치는 실행하지 않고는 나올 수 없는 값이 된다.
 */
const ENV_PATTERNS = [
  /제\s*(?:노트북|맥북|랩탑|랩톱|데스크톱|컴퓨터|서버|로컬)/g,
  /제\s*PC(?![A-Za-z])/g,
  /제\s*환경(?:에서|은|의|\()/g,
];

/**
 * 매치 **직후** 이 표현이 오면 주장이 아니다 — 조작이 아니라 정상 문장이다.
 *   봐야/해야  → 독자 권유("직접 써봐야 알 수 있습니다")
 *   못했/않아  → 부인("직접 써보진 못했습니다", "저도 직접 쓰진 않아서")
 *   세요/시면  → 명령·조건 제시
 * 창을 짧게(25자) 잡는다 — 길면 같은 문장 뒤쪽의 무관한 부정어까지 삼켜 과소차단이 된다.
 */
const NEGATION_WINDOW = 25;
const NEGATION_RE = /봐야|해야|보셔|세요|십시오|시길|보시면|보진\s*못|지\s*않|진\s*않|못했|못\s*했|않았|않아|않은|않습니다|없었|없습니다|다면/;

// ─── 유틸 ─────────────────────────────────────────────────────────────────────

/** YAML frontmatter 제거 후 본문 반환 */
function stripFrontmatter(text) {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return m ? m[1] : text;
}

/** 코드블록·인라인코드 제거 (분석 오염 방지) */
function stripCode(text) {
  let t = text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm, '');
  t = t.replace(/`[^`\n]+`/g, '');
  return t;
}

/** 마크다운 헤딩·링크 마크업 제거 (링크 텍스트·alt 는 남긴다 — 거기에도 주장이 실린다) */
function stripMarkdown(text) {
  let t = text.replace(/^#{1,6}\s+/gm, '');
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1');
  return t;
}

/** 매치 주변 문맥 — 사람이 보고 판단할 수 있을 만큼만 */
function contextOf(text, index, length) {
  return text.slice(Math.max(0, index - 30), index + length + 30).replace(/\s+/g, ' ').trim();
}

// ─── 분석 ─────────────────────────────────────────────────────────────────────

/**
 * 본문에서 1인칭 실행 주장을 찾는다.
 * @param {string} body frontmatter 를 제거한 본문
 * @returns {{phrase:string, kind:string, context:string}[]}
 */
export function findClaims(body) {
  const cleaned = stripMarkdown(stripCode(body));
  const claims = [];
  const seen = new Set();

  const scan = (patterns, kind) => {
    for (const re of patterns) {
      re.lastIndex = 0;
      for (const m of cleaned.matchAll(re)) {
        const after = cleaned.slice(m.index + m[0].length, m.index + m[0].length + NEGATION_WINDOW);
        if (NEGATION_RE.test(after)) continue;      // 권유·부인 → 조작 아님
        const key = `${m.index}:${m[0]}`;
        if (seen.has(key)) continue;                // 패턴이 겹쳐도 한 건으로 센다
        seen.add(key);
        claims.push({ phrase: m[0].replace(/\s+/g, ' '), kind, context: contextOf(cleaned, m.index, m[0].length) });
      }
    }
  };

  scan(CLAIM_PATTERNS, 'execution');
  scan(ENV_PATTERNS, 'owned_environment');

  claims.sort((a, b) => a.context.localeCompare(b.context));
  return claims;
}

function analyze(body) {
  const claims = findClaims(body);
  const pass = claims.length < CLAIM_THRESHOLD;

  const reason = pass
    ? '1인칭 실행·측정 주장 없음'
    : `조작된 실행 주장 ${claims.length}건 — 작가는 도구가 Read·Write 뿐이라 실행·측정할 수 없다. `
      + `출처 귀속("공식 문서 기준 N초")·비교 분석으로 바꿔라. 예: ${claims.slice(0, 3).map(c => `"${c.phrase}"`).join(', ')}`;

  return {
    gate: 'firsthand',
    pass,
    reason,
    evidence: {
      claim_count: claims.length,
      claim_threshold: CLAIM_THRESHOLD,
      claims: claims.slice(0, 10),   // 전량 덤프는 감사로그를 부풀린다
    },
  };
}

// ─── 진입점 ──────────────────────────────────────────────────────────────────

export function evaluate(draftPath) {
  let raw;
  try {
    raw = readFileSync(resolve(draftPath), 'utf8');
  } catch (e) {
    throw new GateError(`파일 읽기 실패: ${e.message}`, { cause: e });
  }

  return analyze(stripFrontmatter(raw));
}

// CLI 로 직접 실행될 때만 돈다. 가드가 없으면 run-all-gates 가 import 하는 순간
// 이 게이트가 stdout 을 쓰고 process.exit 해 버린다(2026-08-21 실측).
if (isMainModule(import.meta.url)) {
  await runGateCli({
    gate: 'firsthand',
    evaluate,
    usage: 'Usage: check-firsthand.mjs <draft.md>',
  });
}
