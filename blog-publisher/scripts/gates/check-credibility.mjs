#!/usr/bin/env node
/**
 * check-credibility.mjs — 가짜 전문성 탐지 게이트
 *
 * 1인칭 경험 앵커 표현이 많은데 구체 증거 밀도가 낮으면 FAIL.
 * "제 경험상..." 을 반복하지만 숫자·날짜·고유명사 등 알맹이가 없는
 * 가짜 전문성(fake expertise) 패턴을 잡는다.
 *
 * 입력: argv[2] = 초안 .md 절대경로
 * 출력: stdout JSON 1줄
 * exit: 0=통과 / 1=실패 / 2=실행오류
 *
 * 판정 규칙:
 *   - 경험 앵커 < ANCHOR_THRESHOLD → pass (앵커 자체가 적으면 가짜 전문성 패턴 아님)
 *   - 경험 앵커 >= ANCHOR_THRESHOLD AND 구체 증거 토큰 >= CONCRETE_MIN → pass
 *   - 경험 앵커 >= ANCHOR_THRESHOLD AND 구체 증거 토큰 <  CONCRETE_MIN → fail
 *
 * 캘리브레이션 (good-01~30 전수):
 *   - good 최대 앵커: 3 (good-17-wolf-schedule)  → ANCHOR_THRESHOLD=5 로 good 전체 커버
 *   - bad-06 앵커: 12, concrete: 2               → CONCRETE_MIN=5 로 FAIL
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── 임계값 ────────────────────────────────────────────────────────────────────

/** 경험 앵커 최소 발동 횟수. 이 미만이면 체크 자체를 건너뜀. */
const ANCHOR_THRESHOLD = 5;

/** 앵커 발동 시 요구되는 구체 증거 토큰 최소 수. 미달이면 FAIL. */
const CONCRETE_MIN = 5;

// ─── 패턴 ─────────────────────────────────────────────────────────────────────

/**
 * 1인칭 경험 앵커 표현 목록.
 * 전문성을 주장하는 경험 서술어 — 이것이 많으면 "경험 전문가" 포지셔닝.
 */
const ANCHOR_PATTERN = /제 경험상|제가 직접|제가 보니|제가 자문|현장에서|목격|경험한 바/g;

/**
 * 구체 증거 토큰 패턴.
 * 숫자·퍼센트·기간·고유명사(영문 대문자 2글자+) 를 실제 알맹이로 간주.
 *
 * 포함:
 *   - 숫자+단위: 23건, 40%, 6개월, 10년, 3배 등
 *   - 영문 고유명사/브랜드: Notion, GitHub, GPT-4 등 (대문자 시작 2자+)
 *   - 인용 부호 속 고유명사: '칼 뉴포트' 등
 *
 * 제외:
 *   - 코드블록 내 토큰 (stripCode 후 적용)
 *   - 단독 숫자 (단위 없는 1, 2, 3은 목록 번호일 뿐)
 */
const CONCRETE_PATTERN = /\d+%|\d+개월|\d+년|\d+건|\d+편|\d+명|\d+번|\d+회|\d+배|\d+시간|\d+일|\d+주|[A-Z][A-Za-z]{1,}/g;

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

// ─── 분석 ─────────────────────────────────────────────────────────────────────

function analyze(body) {
  const cleaned = stripCode(body);

  // 경험 앵커 카운트
  ANCHOR_PATTERN.lastIndex = 0;
  const anchorMatches = [...cleaned.matchAll(ANCHOR_PATTERN)];
  const anchorCount = anchorMatches.length;

  // 구체 증거 토큰 카운트
  CONCRETE_PATTERN.lastIndex = 0;
  const concreteMatches = [...cleaned.matchAll(CONCRETE_PATTERN)];
  const concreteCount = concreteMatches.length;
  const concreteSamples = concreteMatches.map(m => m[0]).slice(0, 10);

  // 앵커 임계 미만 → 가짜 전문성 패턴 아님
  if (anchorCount < ANCHOR_THRESHOLD) {
    return {
      gate: 'credibility',
      pass: true,
      reason: `경험앵커 ${anchorCount}건 (임계 ${ANCHOR_THRESHOLD} 미만) — 가짜전문성 패턴 없음`,
      evidence: {
        anchor_count: anchorCount,
        concrete_count: concreteCount,
        anchor_threshold: ANCHOR_THRESHOLD,
        concrete_min: CONCRETE_MIN,
        concrete_samples: concreteSamples,
      },
    };
  }

  // 앵커 임계 이상 → 구체 증거 밀도 확인
  const pass = concreteCount >= CONCRETE_MIN;

  let reason;
  if (pass) {
    reason = `경험앵커 ${anchorCount}건이지만 구체증거 ${concreteCount}건 (≥${CONCRETE_MIN}) — 가짜전문성 아님`;
  } else {
    reason = `가짜전문성 감지: 경험앵커 ${anchorCount}건, 구체증거 ${concreteCount}건 (< ${CONCRETE_MIN}) — 알맹이 없는 경험 주장`;
  }

  return {
    gate: 'credibility',
    pass,
    reason,
    evidence: {
      anchor_count: anchorCount,
      concrete_count: concreteCount,
      anchor_threshold: ANCHOR_THRESHOLD,
      concrete_min: CONCRETE_MIN,
      concrete_samples: concreteSamples,
    },
  };
}

// ─── 진입점 ──────────────────────────────────────────────────────────────────

function main() {
  const draftPath = process.argv[2];
  if (!draftPath) {
    process.stderr.write('Usage: check-credibility.mjs <draft.md>\n');
    process.exit(2);
  }

  let raw;
  try {
    raw = readFileSync(resolve(draftPath), 'utf8');
  } catch (e) {
    process.stderr.write(`check-credibility: 파일 읽기 실패: ${e.message}\n`);
    process.exit(2);
  }

  const body = stripFrontmatter(raw);
  const result = analyze(body);

  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(result.pass ? 0 : 1);
}

main();
