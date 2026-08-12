#!/usr/bin/env node
/**
 * check-lint.mjs — markdownlint-cli2 (있으면) 또는 내장 간이 린트
 * 내장 규칙: H1 정확히 1개, 헤딩 앞뒤 빈 줄
 * 입력: argv[2] = 초안 .md 절대경로
 * 출력: stdout JSON 1줄
 * exit: 0=통과 / 1=실패 / 2=실행오류
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, '../../');

/** markdownlint-cli2 바이너리 탐색 (로컬 node_modules 우선) */
function findMarkdownlintBin() {
  const candidates = [
    join(REPO_ROOT, 'node_modules', '.bin', 'markdownlint-cli2'),
    join(REPO_ROOT, 'site', 'node_modules', '.bin', 'markdownlint-cli2'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** 내장 간이 린트 */
function builtinLint(text) {
  const errors = [];
  const lines = text.split('\n');

  // H1 개수 (frontmatter 포함이어도 OK — frontmatter 안 # 없음)
  const h1Lines = lines.filter(l => /^# /.test(l));
  if (h1Lines.length === 0) {
    errors.push({ rule: 'MD041', line: 1, message: 'H1 제목이 없습니다' });
  } else if (h1Lines.length > 1) {
    errors.push({ rule: 'MD041', line: lines.indexOf(h1Lines[1]) + 1, message: `H1이 ${h1Lines.length}개 — 1개여야 합니다` });
  }

  // 헤딩 앞 빈 줄 (MD022: 헤딩 앞에 빈 줄 필요, 첫 번째 줄은 예외)
  for (let i = 1; i < lines.length; i++) {
    if (/^#{1,6} /.test(lines[i])) {
      if (lines[i - 1].trim() !== '') {
        errors.push({ rule: 'MD022', line: i + 1, message: `헤딩 앞 빈 줄 없음 (${lines[i].slice(0, 40)})` });
      }
    }
  }

  // 헤딩 뒤 빈 줄 (MD022)
  for (let i = 0; i < lines.length - 1; i++) {
    if (/^#{1,6} /.test(lines[i])) {
      if (lines[i + 1].trim() !== '') {
        errors.push({ rule: 'MD022', line: i + 1, message: `헤딩 뒤 빈 줄 없음 (${lines[i].slice(0, 40)})` });
      }
    }
  }

  return errors;
}

/** YAML frontmatter 제거 후 본문 반환 */
function stripFrontmatter(text) {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return m ? m[1] : text;
}

async function main() {
  const draftPath = process.argv[2];
  if (!draftPath) {
    process.stderr.write('Usage: check-lint.mjs <draft.md>\n');
    process.exit(2);
  }

  const absPath = resolve(draftPath);
  let raw;
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch (e) {
    process.stderr.write(`check-lint: 파일 읽기 실패: ${e.message}\n`);
    process.exit(2);
  }

  const bin = findMarkdownlintBin();

  if (bin) {
    // markdownlint-cli2 사용
    process.stderr.write(`check-lint: markdownlint-cli2 사용 (${bin})\n`);
    try {
      await execFileAsync(bin, [absPath], { cwd: REPO_ROOT });
      // exit 0 = 오류 없음
      const result = {
        gate: 'lint',
        pass: true,
        reason: 'markdownlint-cli2: 오류 없음',
        evidence: { tool: 'markdownlint-cli2', errors: [] },
      };
      process.stdout.write(JSON.stringify(result) + '\n');
      process.exit(0);
    } catch (e) {
      // exit 1 = 린트 오류 있음, stdout/stderr에 오류 목록
      const output = (e.stdout || '') + (e.stderr || '');
      const lines = output.split('\n').filter(Boolean);
      const errors = lines.map(l => ({ message: l }));
      const pass = errors.length === 0;
      const result = {
        gate: 'lint',
        pass,
        reason: pass ? '오류 없음' : `markdownlint-cli2 오류 ${errors.length}건`,
        evidence: { tool: 'markdownlint-cli2', errors: errors.slice(0, 20) },
      };
      process.stdout.write(JSON.stringify(result) + '\n');
      process.exit(pass ? 0 : 1);
    }
  } else {
    // 내장 간이 린트 (graceful fallback)
    process.stderr.write('check-lint: markdownlint-cli2 없음 — 내장 간이 린트 사용\n');
    const body = stripFrontmatter(raw);
    const errors = builtinLint(body);
    const pass = errors.length === 0;
    const result = {
      gate: 'lint',
      pass,
      reason: pass
        ? '내장 린트: 오류 없음'
        : `내장 린트 오류 ${errors.length}건`,
      evidence: { tool: 'builtin', errors },
    };
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(pass ? 0 : 1);
  }
}

main();
