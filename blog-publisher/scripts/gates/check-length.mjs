#!/usr/bin/env node
/**
 * check-length.mjs — 한글 음절 카운트 (U+AC00~U+D7A3)
 * 코드블록·HTML 제거 후 본문만 계산.
 * 입력: argv[2] = 초안 .md 절대경로
 * 출력: stdout JSON 1줄
 * exit: 0=통과 / 1=실패 / 2=실행오류
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';


import { runGateCli, GateError, loadGateConfig } from './lib/gate-cli.mjs';
import { isMainModule } from '../lib/main-module.mjs';
const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, '../../');

// 설정은 config/pipeline.json 하나가 단일 출처다 — 읽기에 실패하면 코드의 기본값으로
// 폴백하지 않고 던진다(옛 기준으로 조용히 판정하는 것이 최악이다).
function loadConfig() {
  return loadGateConfig(readFileSync);
}

/** YAML frontmatter 제거 후 본문 반환 */
function stripFrontmatter(text) {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return m ? m[1] : text;
}

/** 코드블록(``` ``` 및 인덴트 블록)과 HTML 태그 제거 */
function stripCodeAndHtml(text) {
  // 펜스드 코드블록 제거 (``` ... ``` 또는 ~~~ ... ~~~)
  let t = text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm, '');
  // 인라인 코드 제거 (` ... `)
  t = t.replace(/`[^`\n]+`/g, '');
  // HTML 태그 제거
  t = t.replace(/<[^>]+>/g, '');
  return t;
}

/** 한글 음절 카운트 */
function countKoreanSyllables(text) {
  return [...text].filter(c => c >= '가' && c <= '힣').length;
}

export function evaluate(draftPath) {

  let raw;
  try {
    raw = readFileSync(resolve(draftPath), 'utf8');
  } catch (e) {
    throw new GateError(`파일 읽기 실패: ${e.message}`, { cause: e });
  }

  const config = loadConfig();
  const MIN = config?.length?.min ?? 1500;
  const MAX = config?.length?.max ?? 2000;

  const body = stripFrontmatter(raw);
  const cleaned = stripCodeAndHtml(body);
  const syllable_count = countKoreanSyllables(cleaned);

  const pass = syllable_count >= MIN && syllable_count <= MAX;
  const result = {
    gate: 'length',
    pass,
    reason: pass
      ? `음절 수 ${syllable_count} ∈ [${MIN}, ${MAX}]`
      : `음절 수 ${syllable_count} — 범위 [${MIN}, ${MAX}] 벗어남`,
    evidence: { syllable_count },
  };

  return result;
}

// CLI 로 직접 실행될 때만 돈다. 가드가 없으면 run-all-gates 가 import 하는 순간
// 이 게이트가 stdout 을 쓰고 process.exit 해 버린다(2026-08-21 실측).
if (isMainModule(import.meta.url)) {
  await runGateCli({
    gate: 'length',
    evaluate,
    usage: 'Usage: check-length.mjs <draft.md>',
  });
}