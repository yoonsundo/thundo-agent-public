#!/usr/bin/env node
/**
 * check-density.mjs — 정보 밀도 게이트
 *
 * 문장 단위로 분리 후 구체 토큰(숫자+단위, 영문 고유명사 3자+,
 * 한글 수량사+단위, 시간 기준어) 포함 문장 비율(concrete_sentence_ratio)을 측정.
 * 비율이 너무 낮으면 얕은 일반론으로 판정해 FAIL.
 *
 * 입력: argv[2] = 초안 .md 절대경로
 * 출력: stdout JSON 1줄
 * exit: 0=통과 / 1=실패 / 2=실행오류
 *
 * 판정 규칙:
 *   concrete_sentence_ratio < DENSITY_THRESHOLD → fail (얕은 일반론)
 *   그 외 → pass
 *
 * 캘리브레이션 (good-01~30 전수 + bad-08):
 *   - good-30 (경험 위주, 수치 적음): ratio=0.077 — 작년/두 달 등 포함 → pass
 *   - good-24 (오피니언, 고유명사 적음): ratio=0.081 → pass
 *   - bad-08 (완전 일반론): ratio=0.039 → fail
 *   - 임계 0.05: good 전수(min=0.077) 통과, bad-08(0.039) 확실한 FAIL
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';


import { runGateCli, GateError } from './lib/gate-cli.mjs';
import { isMainModule } from '../lib/main-module.mjs';
// ─── 임계값 ────────────────────────────────────────────────────────────────────

/** 구체 토큰 포함 문장 비율. 이 미만이면 얕은 일반론으로 판정. */
const DENSITY_THRESHOLD = 0.05;

// ─── 패턴 ─────────────────────────────────────────────────────────────────────

/**
 * 구체 토큰 패턴 목록 — 문장 내 하나라도 매칭되면 "구체 문장"으로 분류.
 *
 * 포함:
 *   - 숫자+단위: 40분, 23건, 6개월, 3배, 1500자, 8개, 10% 등
 *   - 영문 고유명사 3자+: Claude, Node, GitHub, GPT-4 등 (2자 이하 AI/JS 등 제외)
 *   - 한글 수량사+단위: 두 달, 세 편, 열 건 등 (동사 어미 '한건지' 오탐 방지를 위해 앞에 공백 필요)
 *   - 일주일·한달·두달 등 붙여쓴 기간 표현
 *   - 작년·올해 등 시간 기준어 (경험 근거)
 *
 * 제외:
 *   - "AI", "JS", "UI" 등 2자 이하 대문자 약어
 *   - 목록 번호(1. 2.)와 혼동될 2자리 숫자 단독
 *   - 코드블록 내 토큰 (stripCode 후 적용)
 */
const CONCRETE_PATTERNS = [
  // 숫자+단위 (아라비아 숫자)
  /\d+\s*(?:분|시간|일|주|달|개월|년|건|편|명|번|회|배|자|글자|줄|개|%|원|달러|억)/,
  // 아라비아 숫자 2자리+ (단독)
  /(?<![.\s])\b\d{2,}\b(?!\s*[.)])/,
  // 영문 고유명사 3자+ (AI/JS/UI 등 2자 약어 제외)
  /[A-Z][A-Za-z]{2,}/,
  // 한글 수량사+단위 (앞에 공백/구두점/줄시작 — 동사어미 오탐 방지)
  /(?:^|[\s,。.!?]|—)(?:한|두|세|네|다섯|여섯|일곱|여덟|아홉|열|열한|열두|스물|서른)\s*(?:개|편|건|명|번|회|달|년|시간|분|줄|번째|배)/,
  // 붙여쓴 기간 표현
  /일주일|한달|두달|세달|한\s*달|두\s*달|세\s*달|수십\s*(?:개|명|번|편|건)|수백|수천|수만/,
  // 시간 기준어 (경험 근거)
  /작년|올해|지난해|올초|작년초/,
];

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

/** 마크다운 헤딩·링크·강조 제거 (순수 텍스트) */
function stripMarkdown(text) {
  let t = text.replace(/^#{1,6}\s+/gm, '');
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  t = t.replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1');
  return t;
}

/**
 * 텍스트를 문장 단위로 분리.
 * 마침표·느낌표·물음표 뒤 공백/줄바꿈, 또는 종결어미 뒤 줄바꿈 기준.
 * 5자 미만 제거.
 */
function splitSentences(text) {
  const raw = text.split(/(?<=[.!?。])\s+|(?<=다[.。])\s*\n|(?<=요[.。]?)\s*\n/);
  return raw.map(s => s.trim()).filter(s => s.length >= 5);
}

/** 문장 내 구체 토큰 포함 여부 */
function hasConcrete(sentence) {
  return CONCRETE_PATTERNS.some(re => re.test(sentence));
}

// ─── 분석 ─────────────────────────────────────────────────────────────────────

function analyze(body) {
  const cleaned = stripMarkdown(stripCode(body));
  const sentences = splitSentences(cleaned);
  const total = sentences.length;

  if (total === 0) {
    return {
      gate: 'density',
      pass: false,
      reason: '문장을 추출할 수 없음',
      evidence: { concrete_sentence_ratio: 0, total_sentences: 0 },
    };
  }

  const concreteSentences = sentences.filter(hasConcrete);
  const concreteCount = concreteSentences.length;
  const ratio = concreteCount / total;
  const ratioRounded = Math.round(ratio * 1000) / 1000;

  const pass = ratio >= DENSITY_THRESHOLD;

  let reason;
  if (pass) {
    reason = `정보밀도 충분: 구체문장 ${concreteCount}/${total} (${Math.round(ratio * 100)}%)`;
  } else {
    reason = `얕은 일반론: 구체문장 비율 ${Math.round(ratio * 100)}% (임계 ${Math.round(DENSITY_THRESHOLD * 100)}% 미달) — 숫자·고유명사·인용 부족`;
  }

  return {
    gate: 'density',
    pass,
    reason,
    evidence: {
      concrete_sentence_ratio: ratioRounded,
      total_sentences: total,
      concrete_sentence_count: concreteCount,
      density_threshold: DENSITY_THRESHOLD,
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
    gate: 'density',
    evaluate,
    usage: 'Usage: check-density.mjs <draft.md>',
  });
}