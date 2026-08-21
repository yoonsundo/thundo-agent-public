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


import { runGateCli, GateError } from './lib/gate-cli.mjs';
import { isMainModule } from '../lib/main-module.mjs';
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
    throw new GateError(`banned-terms.txt 읽기 실패: ${e.message}`, { cause: e });
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

export function evaluate(draftPath) {

  let raw;
  try {
    raw = readFileSync(resolve(draftPath), 'utf8');
  } catch (e) {
    throw new GateError(`파일 읽기 실패: ${e.message}`, { cause: e });
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

  return result;
}

// CLI 로 직접 실행될 때만 돈다. 가드가 없으면 run-all-gates 가 import 하는 순간
// 이 게이트가 stdout 을 쓰고 process.exit 해 버린다(2026-08-21 실측).
if (isMainModule(import.meta.url)) {
  await runGateCli({
    gate: 'banned',
    evaluate,
    usage: 'Usage: check-banned.mjs <draft.md>',
  });
}