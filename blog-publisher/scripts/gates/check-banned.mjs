#!/usr/bin/env node
/**
 * check-banned.mjs — banned-terms.txt 패턴 매칭
 * 입력: argv[2] = 초안 .md 절대경로
 * 출력: stdout JSON 1줄
 * exit: 0=통과 / 1=실패 / 2=실행오류
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, '../../');
const BANNED_PATH = join(REPO_ROOT, 'config', 'banned-terms.txt');

/** YAML frontmatter 제거 후 본문 반환 */
function stripFrontmatter(text) {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return m ? m[1] : text;
}

/** banned-terms.txt 파싱: 빈줄·#주석 제거 후 각 줄을 정규식으로 컴파일 */
function loadPatterns(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    process.stderr.write(`check-banned: banned-terms.txt 읽기 실패: ${e.message}\n`);
    process.exit(2);
  }

  const patterns = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    try {
      patterns.push({ term: trimmed, re: new RegExp(trimmed, 'g') });
    } catch (e) {
      process.stderr.write(`check-banned: 패턴 컴파일 실패 [${trimmed}]: ${e.message}\n`);
      // graceful: 컴파일 실패 패턴은 건너뜀
    }
  }
  return patterns;
}

function main() {
  const draftPath = process.argv[2];
  if (!draftPath) {
    process.stderr.write('Usage: check-banned.mjs <draft.md>\n');
    process.exit(2);
  }

  let raw;
  try {
    raw = readFileSync(resolve(draftPath), 'utf8');
  } catch (e) {
    process.stderr.write(`check-banned: 파일 읽기 실패: ${e.message}\n`);
    process.exit(2);
  }

  const body = stripFrontmatter(raw);
  const patterns = loadPatterns(BANNED_PATH);

  const hits = [];
  for (const { term, re } of patterns) {
    // reset lastIndex (g 플래그)
    re.lastIndex = 0;
    const matches = [...body.matchAll(re)];
    if (matches.length > 0) {
      hits.push({ term, count: matches.length });
    }
  }

  const pass = hits.length === 0;
  const result = {
    gate: 'banned',
    pass,
    reason: pass
      ? '금지어 없음'
      : `금지어 ${hits.length}종 발견: ${hits.map(h => h.term).join(', ')}`,
    evidence: { hits },
  };

  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(pass ? 0 : 1);
}

main();
