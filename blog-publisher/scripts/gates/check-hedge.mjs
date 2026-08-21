#!/usr/bin/env node
/**
 * check-hedge.mjs — 헤징 밀도 게이트
 *
 * 헤징 종결 문장("~일 수 있", "다를 수 있", "어렵습니다", "알 수 없",
 * "불분명", "경우에 따라", "단정하기 어렵") 비율(hedge_ratio)이 높고
 * 구체 증거 토큰(concrete_count)이 전혀 없으면 FAIL.
 *
 * 입력: argv[2] = 초안 .md 절대경로
 * 출력: stdout JSON 1줄
 * exit: 0=통과 / 1=실패 / 2=실행오류
 *
 * 판정 규칙:
 *   hedge_ratio > HEDGE_THRESHOLD AND concrete_count == 0 → fail (입장·정보 없음)
 *   그 외 → pass
 *
 * 캘리브레이션 (good-01~30 전수 + bad-09):
 *   - good-30 (헤징 일부 있으나 결론·수치 있음): concrete_count > 0 → pass
 *   - bad-09 (과잉헤징): 거의 모든 문장이 헤징 종결, concrete_count=0 → fail
 *   - 임계 hedge_ratio > 0.35: bad-09 확실한 FAIL, good 전수 pass 보장
 *     (good 중 헤징 최다 사용 파일도 concrete_count > 0 이므로 통과)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';


import { runGateCli, GateError } from './lib/gate-cli.mjs';
import { isMainModule } from '../lib/main-module.mjs';
// ─── 임계값 ────────────────────────────────────────────────────────────────────

/** 헤징 문장 비율 임계. 이 초과 AND concrete_count==0 이면 FAIL. */
const HEDGE_THRESHOLD = 0.35;

// ─── 패턴 ─────────────────────────────────────────────────────────────────────

/**
 * 헤징 종결 패턴 목록.
 * 문장 내 포함 여부로 판정 (종결 위치 제한 없음 — 종결어미가 아니더라도
 * 헤징 표현이 문장 중간에 있어도 해당 문장을 헤징 문장으로 분류).
 */
const HEDGE_PATTERNS = [
  /일\s*수\s*있/,          // ~일 수 있
  /다를\s*수\s*있/,        // 다를 수 있
  /어렵습니다/,            // 어렵습니다
  /어렵(?:죠|네요|다고)/,  // 어렵죠 / 어렵네요 / 어렵다고
  /알\s*수\s*없/,          // 알 수 없
  /불분명/,                // 불분명
  /경우에\s*따라/,         // 경우에 따라
  /단정하기\s*어렵/,       // 단정하기 어렵
  /단정(?:할\s*수\s*없|짓기\s*어렵)/, // 단정할 수 없 / 단정짓기 어렵
  /말하기\s*어렵/,         // 말하기 어렵
  /보기\s*어렵/,           // 보기 어렵
  /판단하기\s*어렵/,       // 판단하기 어렵
];

/**
 * 구체 증거 토큰 패턴 — check-credibility.mjs 와 동일 기준.
 * 숫자+단위, 영문 고유명사(대문자 시작 2자+).
 */
const CONCRETE_PATTERN = /\d+%|\d+개월|\d+년|\d+건|\d+편|\d+명|\d+번|\d+회|\d+배|\d+시간|\d+일|\d+주|\d+분|\d+자|\d{2,}|[A-Z][A-Za-z]{1,}/g;

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

/** 마크다운 헤딩·링크 등 제거 */
function stripMarkdown(text) {
  let t = text.replace(/^#{1,6}\s+/gm, '');
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  t = t.replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1');
  return t;
}

/**
 * 텍스트를 문장 단위로 분리.
 */
function splitSentences(text) {
  const raw = text.split(/(?<=[.!?。])\s+|(?<=다[.。])\s*\n|(?<=요[.。]?)\s*\n/);
  return raw.map(s => s.trim()).filter(s => s.length >= 5);
}

/** 문장 내 헤징 표현 포함 여부 */
function isHedge(sentence) {
  return HEDGE_PATTERNS.some(re => re.test(sentence));
}

// ─── 분석 ─────────────────────────────────────────────────────────────────────

function analyze(body) {
  const cleaned = stripMarkdown(stripCode(body));
  const sentences = splitSentences(cleaned);
  const total = sentences.length;

  if (total === 0) {
    return {
      gate: 'hedge',
      pass: true,
      reason: '문장 없음 — 헤징 판정 불가 (통과)',
      evidence: { hedge_ratio: 0, concrete_count: 0, total_sentences: 0 },
    };
  }

  // 헤징 문장 카운트
  const hedgeSentences = sentences.filter(isHedge);
  const hedgeCount = hedgeSentences.length;
  const hedgeRatio = hedgeCount / total;
  const hedgeRatioRounded = Math.round(hedgeRatio * 1000) / 1000;

  // 구체 증거 토큰 카운트 (전체 본문 기준)
  CONCRETE_PATTERN.lastIndex = 0;
  const concreteMatches = [...cleaned.matchAll(CONCRETE_PATTERN)];
  const concreteCount = concreteMatches.length;

  // 판정: hedge_ratio > HEDGE_THRESHOLD AND concrete_count == 0
  const tooMuchHedge = hedgeRatio > HEDGE_THRESHOLD;
  const noConcreteEvidence = concreteCount === 0;
  const pass = !(tooMuchHedge && noConcreteEvidence);

  let reason;
  if (!pass) {
    reason = `과잉헤징: 헤징문장 ${hedgeCount}/${total} (${Math.round(hedgeRatio * 100)}% > ${Math.round(HEDGE_THRESHOLD * 100)}%) + 구체증거 0건 — 입장·정보 없음`;
  } else if (tooMuchHedge) {
    reason = `헤징 비율 높음(${Math.round(hedgeRatio * 100)}%)이나 구체증거 ${concreteCount}건 있어 통과`;
  } else {
    reason = `헤징 비율 ${Math.round(hedgeRatio * 100)}% — 정상 범위`;
  }

  return {
    gate: 'hedge',
    pass,
    reason,
    evidence: {
      hedge_ratio: hedgeRatioRounded,
      hedge_sentence_count: hedgeCount,
      total_sentences: total,
      concrete_count: concreteCount,
      hedge_threshold: HEDGE_THRESHOLD,
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

  const body = stripFrontmatter(raw);
  const result = analyze(body);

  return result;
}

// CLI 로 직접 실행될 때만 돈다. 가드가 없으면 run-all-gates 가 import 하는 순간
// 이 게이트가 stdout 을 쓰고 process.exit 해 버린다(2026-08-21 실측).
if (isMainModule(import.meta.url)) {
  await runGateCli({
    gate: 'hedge',
    evaluate,
    usage: 'Usage: check-hedge.mjs <draft.md>',
  });
}