#!/usr/bin/env node
/**
 * check-seo.mjs — SEO 기본 요소 검사 (게이트 15번)
 *
 * 검사 항목:
 *   1. title 길이  — 프론트매터 title 존재 + 20~65자
 *   2. description — 존재 시에만 120~160자 검사 (선택 필드; 없어도 통과)
 *   3. 첫 섹션 키워드 — title 첫 2어절 중 1개 이상이 body 앞 600자 이내 등장 (H1 포함)
 *   4. FAQ 형태    — ## 자주 묻는 질문 섹션 있을 때만 **Q.** 3~5개 + A. 쌍 검사
 *                   (섹션 없으면 통과 — FAQ는 권장이며 작가 지침 몫)
 *
 * 캘리브레이션 근거 (benchmark/seed 33편 실측, 2026-07-02):
 *   - title 실측 분포: 29~60자.  원 스펙 30~60자에서 하한 20자로 낮춤
 *     (최단 seed가 29자이며 여유 확보 위해 20자로 조정)
 *   - description: 33편 중 보유 편수 ≈ 0-1. 필수 검사 시 seed 100% fail → 선택 필드로 처리
 *   - FAQ: 33편 모두 섹션 없음. 없으면 통과(있을 때만 형태 검사)
 *
 * 입력: argv[2] = 초안 .md 절대경로
 * 출력: stdout JSON 1줄 {gate, pass, reason, evidence}
 * exit: 0=통과 / 1=실패 / 2=실행오류
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── 임계값 (캘리브레이션 후 값) ─────────────────────────────
const TITLE_MIN = 20;   // 원 스펙 30자 → 하향 (seed 최단 29자)
const TITLE_MAX = 65;   // 원 스펙 60자 → 소폭 상향 (seed 최장 60자 + 여유 5자)
const DESC_MIN  = 120;
const DESC_MAX  = 160;
const FAQ_HEADING  = '## 자주 묻는 질문';
const FAQ_Q_MIN    = 3;
const FAQ_Q_MAX    = 5;
const FIRST_SECTION_CHARS = 600; // H1 헤딩 포함 앞부분 검사 범위

// ── 파서 헬퍼 ───────────────────────────────────────────────

/** YAML frontmatter 파싱: {meta: Map, body: string} */
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { meta: new Map(), body: text };

  const meta = new Map();
  for (const line of m[1].split('\n')) {
    // 들여쓰기 있는 줄(source_refs 내부 등) 스킵 — 중첩 title: 이 최상위 title: 덮어쓰는 것 방지
    if (/^\s/.test(line)) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim().replace(/^["']|["']$/g, ''); // 따옴표 제거
    if (key && val) meta.set(key, val);
  }
  return { meta, body: m[2] };
}

/** 문자 수 (Unicode code point 기준) */
function charLen(str) {
  return [...str].length;
}

// ── 검사 함수 ────────────────────────────────────────────────

/**
 * 1. title 길이 검사
 * returns {pass, reason, evidence}
 */
function checkTitle(meta) {
  const title = meta.get('title') ?? '';
  if (!title) {
    return { pass: false, reason: 'frontmatter title 필드 없음', evidence: { title_chars: 0 } };
  }
  const len = charLen(title);
  const pass = len >= TITLE_MIN && len <= TITLE_MAX;
  return {
    pass,
    reason: pass
      ? `title ${len}자 ∈ [${TITLE_MIN}, ${TITLE_MAX}]`
      : `title ${len}자 — 범위 [${TITLE_MIN}, ${TITLE_MAX}] 벗어남`,
    evidence: { title_chars: len, title },
  };
}

/**
 * 2. description 길이 검사 (필드가 있을 때만)
 * returns {pass, reason, evidence, skipped}
 */
function checkDescription(meta) {
  const desc = meta.get('description') ?? '';
  if (!desc) {
    // 필드 없음 → 통과 (선택 필드)
    return {
      pass: true,
      reason: 'description 필드 없음 — 선택 필드이므로 통과 (작가 지침: 추가 권장)',
      evidence: { description_chars: 0, present: false },
      skipped: true,
    };
  }
  const len = charLen(desc);
  const pass = len >= DESC_MIN && len <= DESC_MAX;
  return {
    pass,
    reason: pass
      ? `description ${len}자 ∈ [${DESC_MIN}, ${DESC_MAX}]`
      : `description ${len}자 — 범위 [${DESC_MIN}, ${DESC_MAX}] 벗어남`,
    evidence: { description_chars: len, present: true },
  };
}

/**
 * 3. 첫 섹션 키워드 검사
 * title 공백 분리 첫 2어절 중 1개 이상이 body 앞 FIRST_SECTION_CHARS자 이내에 등장해야 함.
 * H1 헤딩(body 첫 줄)이 포함되므로 일반적으로 항상 통과.
 * returns {pass, reason, evidence}
 */
function checkKeyword(meta, body) {
  const title = meta.get('title') ?? '';
  if (!title) {
    return { pass: false, reason: 'title 없어 키워드 검사 불가', evidence: {} };
  }

  const words = title.trim().split(/\s+/).slice(0, 2).filter(w => charLen(w) >= 2);
  if (words.length === 0) {
    return { pass: true, reason: '유효 title 어절 없음 — 키워드 검사 스킵', evidence: { words } };
  }

  const firstSection = [...body].slice(0, FIRST_SECTION_CHARS).join('');
  const firstSectionLower = firstSection.toLowerCase();

  const found = words.filter(w => firstSectionLower.includes(w.toLowerCase()));
  const pass = found.length > 0;

  return {
    pass,
    reason: pass
      ? `title 핵심어 "${found[0]}" 첫 ${FIRST_SECTION_CHARS}자 이내 등장`
      : `title 첫 2어절 [${words.join(', ')}] 중 첫 ${FIRST_SECTION_CHARS}자 이내 미등장`,
    evidence: { checked_words: words, found_words: found },
  };
}

/**
 * 4. FAQ 형태 검사 (섹션 있을 때만)
 * 없으면 통과. 있으면 **Q.** 라인 3~5개 + A. 쌍 형태 준수 여부 검사.
 * returns {pass, reason, evidence, skipped}
 */
function checkFaq(body) {
  const faqIdx = body.indexOf(FAQ_HEADING);
  if (faqIdx === -1) {
    return {
      pass: true,
      reason: `"${FAQ_HEADING}" 섹션 없음 — FAQ는 선택이므로 통과`,
      evidence: { faq_present: false },
      skipped: true,
    };
  }

  const faqSection = body.slice(faqIdx + FAQ_HEADING.length);
  // 다음 ## 헤딩 전까지만 검사
  const nextH2Idx = faqSection.search(/\n## /);
  const faqBody = nextH2Idx !== -1 ? faqSection.slice(0, nextH2Idx) : faqSection;

  // **Q.** 로 시작하는 라인
  const qLines = faqBody.split('\n').filter(l => /^\*\*Q\.\s/.test(l.trim()));
  // A. 로 시작하는 라인
  const aLines = faqBody.split('\n').filter(l => /^A\.\s/.test(l.trim()));

  const qCount = qLines.length;
  const aCount = aLines.length;

  const issues = [];
  if (qCount < FAQ_Q_MIN || qCount > FAQ_Q_MAX) {
    issues.push(`**Q.** 라인 ${qCount}개 — 범위 [${FAQ_Q_MIN}, ${FAQ_Q_MAX}] 벗어남`);
  }
  if (aCount !== qCount) {
    issues.push(`A. 라인 ${aCount}개 — Q 수(${qCount})와 불일치 (Q:A 쌍 필요)`);
  }

  const pass = issues.length === 0;
  return {
    pass,
    reason: pass
      ? `FAQ 형태 정상 (Q ${qCount}개, A ${aCount}개)`
      : `FAQ 형태 오류: ${issues.join('; ')}`,
    evidence: { faq_present: true, q_count: qCount, a_count: aCount, issues },
  };
}

// ── 메인 ────────────────────────────────────────────────────

function main() {
  const draftPath = process.argv[2];
  if (!draftPath) {
    process.stderr.write('Usage: check-seo.mjs <draft.md>\n');
    process.exit(2);
  }

  let raw;
  try {
    raw = readFileSync(resolve(draftPath), 'utf8');
  } catch (e) {
    process.stderr.write(`check-seo: 파일 읽기 실패: ${e.message}\n`);
    process.exit(2);
  }

  const { meta, body } = parseFrontmatter(raw);

  const titleResult = checkTitle(meta);
  const descResult  = checkDescription(meta);
  const kwResult    = checkKeyword(meta, body);
  const faqResult   = checkFaq(body);

  const checks = [titleResult, descResult, kwResult, faqResult];
  const failures = checks.filter(c => !c.pass);
  const pass = failures.length === 0;

  const reasons = failures.length > 0
    ? failures.map(c => c.reason).join('; ')
    : [titleResult, descResult, kwResult, faqResult].map(c => c.reason).join(' | ');

  const result = {
    gate: 'seo',
    pass,
    reason: pass ? `SEO 기본 검사 전체 통과` : `SEO 검사 실패: ${failures.map(c => c.reason).join('; ')}`,
    evidence: {
      title:       titleResult.evidence,
      description: descResult.evidence,
      keyword:     kwResult.evidence,
      faq:         faqResult.evidence,
    },
  };

  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(pass ? 0 : 1);
}

main();
