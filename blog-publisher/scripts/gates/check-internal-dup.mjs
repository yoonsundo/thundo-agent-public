#!/usr/bin/env node
/**
 * check-internal-dup.mjs — 내부 중복(자기재진술) 게이트
 *
 * 본문을 ## 섹션 단위로 분리한 뒤, 섹션 쌍 간 문자 4-gram Jaccard 유사도를
 * 계산해 최대값(max_pair_jaccard)이 임계를 초과하면 내부 반복·재진술로 판정해 FAIL.
 *
 * 입력: argv[2] = 초안 .md 절대경로
 * 출력: stdout JSON 1줄
 * exit: 0=통과 / 1=실패 / 2=실행오류
 *
 * 판정 규칙:
 *   max_pair_jaccard > INTERNAL_DUP_THRESHOLD → fail (내부 재진술 반복)
 *   그 외 → pass
 *
 * 캘리브레이션 (good-01~30 전수 + bad-10):
 *   - good-29 (섹션 유사도 최대): max_pair_jaccard=0.1043 → pass
 *   - bad-10 (내부재진술 반복): max_pair_jaccard=0.1083 → fail
 *   - 임계 0.107: good 전수(max=0.1043) 통과, bad-10(0.1083) 확실한 FAIL
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';


import { runGateCli, GateError } from './lib/gate-cli.mjs';
import { isMainModule } from '../lib/main-module.mjs';
// ─── 임계값 ────────────────────────────────────────────────────────────────────

/** 섹션 쌍 간 4-gram Jaccard 최대값 임계. 이 초과이면 내부 재진술 판정. */
const INTERNAL_DUP_THRESHOLD = 0.107;

// ─── 유틸 ─────────────────────────────────────────────────────────────────────

/** YAML frontmatter 제거 후 본문 반환 */
function stripFrontmatter(text) {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return m ? m[1] : text;
}

/**
 * 본문을 ## 섹션 단위로 분리.
 * ## 헤딩 앞에서 분리, 20자 미만 조각 제거.
 */
function splitSections(body) {
  return body.split(/^##\s+.+$/m)
    .map(s => s.trim())
    .filter(s => s.length >= 20);
}

/** 문자 4-gram 집합 생성 (공백 정규화 후) */
function charFourgrams(text) {
  const chars = [...text.replace(/\s+/g, ' ')];
  const grams = new Set();
  for (let i = 0; i <= chars.length - 4; i++) {
    grams.add(chars.slice(i, i + 4).join(''));
  }
  return grams;
}

/** 두 집합의 Jaccard 유사도 */
function jaccardSets(a, b) {
  let interCount = 0;
  for (const x of a) {
    if (b.has(x)) interCount++;
  }
  const unionCount = a.size + b.size - interCount;
  return unionCount === 0 ? 0 : interCount / unionCount;
}

/** 섹션 쌍 간 최대 Jaccard 계산 */
function maxPairJaccard(body) {
  const sections = splitSections(body);
  if (sections.length < 2) {
    return { max: 0, pair: null };
  }

  const gramSets = sections.map(s => charFourgrams(s));
  let maxJ = 0;
  let bestPair = null;

  for (let i = 0; i < gramSets.length; i++) {
    for (let j = i + 1; j < gramSets.length; j++) {
      const jac = jaccardSets(gramSets[i], gramSets[j]);
      if (jac > maxJ) {
        maxJ = jac;
        bestPair = [i, j];
      }
    }
  }

  return { max: maxJ, pair: bestPair };
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
  const { max: maxJ, pair } = maxPairJaccard(body);
  const maxJRounded = parseFloat(maxJ.toFixed(4));

  const pass = maxJ <= INTERNAL_DUP_THRESHOLD;

  let reason;
  if (pass) {
    reason = `내부 중복 없음: 최대 섹션 쌍 Jaccard ${maxJRounded} ≤ 임계 ${INTERNAL_DUP_THRESHOLD}`;
  } else {
    reason = `내부 재진술 반복: 섹션 쌍 Jaccard ${maxJRounded} > 임계 ${INTERNAL_DUP_THRESHOLD} — 섹션 간 내용 중복`;
  }

  const result = {
    gate: 'internal-dup',
    pass,
    reason,
    evidence: {
      max_pair_jaccard: maxJRounded,
      pair,
      threshold: INTERNAL_DUP_THRESHOLD,
    },
  };

  return result;
}

// CLI 로 직접 실행될 때만 돈다. 가드가 없으면 run-all-gates 가 import 하는 순간
// 이 게이트가 stdout 을 쓰고 process.exit 해 버린다(2026-08-21 실측).
if (isMainModule(import.meta.url)) {
  await runGateCli({
    gate: 'internal-dup',
    evaluate,
    usage: 'Usage: check-internal-dup.mjs <draft.md>',
  });
}