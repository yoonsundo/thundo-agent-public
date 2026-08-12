#!/usr/bin/env node
/**
 * check-length.mjs — 한글 음절 카운트 (U+AC00~U+D7A3)
 * 코드블록·HTML 제거 후 본문만 계산.
 * 입력: argv[2] = 초안 .md 절대경로
 * 출력: stdout JSON 1줄
 * exit: 0=통과 / 1=실패 / 2=실행오류
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, '../../');
const CONFIG_PATH = join(REPO_ROOT, 'config', 'pipeline.json');

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return { length: { min: 1500, max: 2000 } };
  }
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

function main() {
  const draftPath = process.argv[2];
  if (!draftPath) {
    process.stderr.write('Usage: check-length.mjs <draft.md>\n');
    process.exit(2);
  }

  let raw;
  try {
    raw = readFileSync(resolve(draftPath), 'utf8');
  } catch (e) {
    process.stderr.write(`check-length: 파일 읽기 실패: ${e.message}\n`);
    process.exit(2);
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

  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(pass ? 0 : 1);
}

main();
