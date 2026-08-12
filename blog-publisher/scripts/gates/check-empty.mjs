#!/usr/bin/env node
/**
 * check-empty.mjs — ## 섹션 본문 <50자 탐지
 * 입력: argv[2] = 초안 .md 절대경로
 * 출력: stdout JSON 1줄
 * exit: 0=통과 / 1=실패 / 2=실행오류
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));

const MIN_SECTION_CHARS = 50;

/** YAML frontmatter 제거 후 본문 반환 */
function stripFrontmatter(text) {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return m ? m[1] : text;
}

/**
 * ## 헤딩 기준으로 섹션 분리 후 각 섹션 본문 길이 검사
 * 하위 헤딩(### 이하)은 포함해서 계산 (섹션 본문의 일부로 간주)
 */
function detectEmptySections(text) {
  const lines = text.split('\n');
  const empty_sections = [];

  let currentSection = null;
  let bodyLines = [];

  const flush = () => {
    if (currentSection === null) return;
    const bodyText = bodyLines.join('\n').trim();
    // 공백·구분선(---)만 있는 본문 제외 후 실제 텍스트 문자 수
    const charCount = bodyText.replace(/^-{3,}\s*$/gm, '').trim().length;
    if (charCount < MIN_SECTION_CHARS) {
      empty_sections.push({
        heading: currentSection.heading,
        line: currentSection.lineNo,
        char_count: charCount,
      });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // ## 헤딩 감지 (정확히 ## — ### 이하는 서브섹션으로 본문에 포함)
    if (/^## /.test(line)) {
      flush();
      currentSection = { heading: line.trim(), lineNo: i + 1 };
      bodyLines = [];
    } else if (currentSection !== null) {
      bodyLines.push(line);
    }
  }
  flush();

  return empty_sections;
}

function main() {
  const draftPath = process.argv[2];
  if (!draftPath) {
    process.stderr.write('Usage: check-empty.mjs <draft.md>\n');
    process.exit(2);
  }

  let raw;
  try {
    raw = readFileSync(resolve(draftPath), 'utf8');
  } catch (e) {
    process.stderr.write(`check-empty: 파일 읽기 실패: ${e.message}\n`);
    process.exit(2);
  }

  const body = stripFrontmatter(raw);
  const empty_sections = detectEmptySections(body);

  const pass = empty_sections.length === 0;
  const result = {
    gate: 'empty',
    pass,
    reason: pass
      ? '빈 섹션 없음'
      : `빈 섹션 ${empty_sections.length}개 발견 (본문 <${MIN_SECTION_CHARS}자)`,
    evidence: { empty_sections },
  };

  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(pass ? 0 : 1);
}

main();
