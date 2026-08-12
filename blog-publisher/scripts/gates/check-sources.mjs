#!/usr/bin/env node
/**
 * check-sources.mjs — 출처 세탁(citation laundering) 탐지 게이트
 * 입력: argv[2] = 초안 .md 절대경로
 * 출력: stdout JSON 1줄
 * exit: 0=통과 / 1=실패 / 2=실행오류
 *
 * 판정 규칙:
 *   - source_refs 항목 중 url 필드가 빈 문자열("")인 항목이 1개 이상 → fail
 *   - 본문에 기관명+수치 패턴이 있는데 source_refs에 유효 url이 없음 → fail
 *   - 순수 1인칭 경험 수치(기관명 없음)는 통과
 *   - source_refs 자체가 없어도 기관통계 패턴이 없으면 통과
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── 기관명 패턴 ──────────────────────────────────────────────────────────────
// 이 기관명이 본문에 나타나고 수치(%)나 숫자+명 등이 같은 문장에 있으면 인용 필요
// export — 게이트16(check-source-fidelity)이 "외부 귀속 수치" 범위 한정에 재사용한다(ralplan v6 S3).
export const ORG_NAMES_RE = /McKinsey|맥킨지|가트너|Gartner|하버드|스탠퍼드|Stanford|HBR|하버드\s*비즈니스|딜로이트|Deloitte|PwC|KPMG|BCG|보스턴\s*컨설팅|갤럽|Gallup|포레스터|Forrester|액센추어|Accenture|IBM|아이비엠|세계경제포럼|WEF|링크드인|LinkedIn|올리버\s*와이만|Oliver\s*Wyman|버펄로|마이크로소프트|Microsoft|메타\s*분석|에덴스피카/;

// 수치 패턴: XX% 또는 XX명 또는 XX달러 등 구체적 통계 수치
const STAT_NUM_RE = /[0-9]+\s*%|[0-9]+\s*명|[0-9]+\s*달러|[0-9]+\s*배|[0-9]+\s*포인트/;

// ─── YAML frontmatter 파서 ───────────────────────────────────────────────────

/**
 * frontmatter 블록 텍스트 반환 (--- ... --- 사이)
 * 없으면 null
 */
function extractFrontmatterBlock(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return m ? m[1] : null;
}

/**
 * YAML frontmatter 제거 후 본문 반환
 */
function stripFrontmatter(text) {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return m ? m[1] : text;
}

/**
 * source_refs 파싱 — 경량 YAML 파서 (외부 의존 없음)
 * source_refs: 이하 블록에서 - url: "..." 항목 추출
 *
 * 반환: { items: Array<{url:string|null, title:string|null}>, raw_block: string }
 */
function parseSourceRefs(fmBlock) {
  if (!fmBlock) return { items: [], raw_block: '' };

  // source_refs: 로 시작하는 섹션을 찾아 다음 최상위 키 앞까지 추출
  const srMatch = fmBlock.match(/^source_refs:\s*\n([\s\S]*?)(?=^\S|\s*$)/m);
  if (!srMatch) return { items: [], raw_block: '' };

  const block = srMatch[1];

  // 빈 배열 패턴: source_refs: [] 처리
  const emptyArrayMatch = fmBlock.match(/^source_refs:\s*\[\s*\]\s*$/m);
  if (emptyArrayMatch) return { items: [], raw_block: '[]' };

  // 각 항목(- 로 시작) 추출
  const itemBlocks = block.split(/(?=^  - )/m).filter(s => s.trim());

  const items = itemBlocks.map(itemBlock => {
    const urlMatch = itemBlock.match(/url:\s*["']?([^"'\n]*)["']?/);
    const titleMatch = itemBlock.match(/title:\s*["']?([^"'\n]*)["']?/);
    return {
      url: urlMatch ? urlMatch[1].trim() : null,
      title: titleMatch ? titleMatch[1].trim() : null,
    };
  });

  return { items, raw_block: block };
}

// ─── 기관통계 탐지 ────────────────────────────────────────────────────────────

/**
 * 본문에서 기관명+수치 패턴이 있는 문장 탐지
 * 같은 문장 안에 기관명과 수치가 모두 있어야 hit
 */
function detectOrgStatHits(body) {
  // 코드블록 제거
  let cleaned = body.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm, '');
  cleaned = cleaned.replace(/`[^`\n]+`/g, '');

  // 문장 단위로 분리 (줄바꿈 + 마침표 기준)
  const lines = cleaned.split(/\n/);
  const sentences = [];
  for (const line of lines) {
    // 한 줄을 마침표/물음표/느낌표 단위로 다시 분리
    const parts = line.split(/(?<=[.!?。])\s+/);
    sentences.push(...parts.map(s => s.trim()).filter(s => s.length > 5));
  }

  const hits = [];
  for (const sentence of sentences) {
    if (ORG_NAMES_RE.test(sentence) && STAT_NUM_RE.test(sentence)) {
      hits.push(sentence.slice(0, 120));
    }
  }

  return hits;
}

// ─── 메인 분석 ───────────────────────────────────────────────────────────────

function analyze(raw) {
  const fmBlock = extractFrontmatterBlock(raw);
  const body = stripFrontmatter(raw);

  const { items: sourceItems } = parseSourceRefs(fmBlock);

  // 1) 빈 url 항목 탐지 (url 필드가 존재하고 빈 문자열인 경우)
  const emptyUrlRefs = sourceItems
    .filter(item => item.url !== null && item.url === '')
    .map(item => item.title ?? '(제목 없음)');

  // 2) 유효 url 보유 여부 (url 필드가 있고 비어있지 않으면 유효)
  const hasValidSource = sourceItems.some(
    item => item.url !== null && item.url.length > 0
  );

  // 3) 기관명+수치 패턴 탐지
  const orgStatHits = detectOrgStatHits(body);
  const hasOrgStats = orgStatHits.length > 0;

  // 4) 판정
  // - 빈 url 항목이 있으면 → fail
  // - 기관통계 패턴이 있고 유효 출처가 없으면 → fail
  const failEmptyUrl = emptyUrlRefs.length > 0;
  const failCitationLaundering = hasOrgStats && !hasValidSource;

  const pass = !failEmptyUrl && !failCitationLaundering;

  // 5) score (참고용)
  const score = (failEmptyUrl ? 2 : 0) + (failCitationLaundering ? 3 : 0);

  let reason;
  if (failEmptyUrl && failCitationLaundering) {
    reason = `빈 url 항목 ${emptyUrlRefs.length}건 + 기관통계 ${orgStatHits.length}건에 유효 출처 없음`;
  } else if (failEmptyUrl) {
    reason = `source_refs에 url 빈 항목 ${emptyUrlRefs.length}건 (url 필드를 채우거나 항목 제거 필요)`;
  } else if (failCitationLaundering) {
    reason = `기관통계 인용 ${orgStatHits.length}건 감지됐으나 source_refs에 유효 url 없음`;
  } else {
    reason = '출처 세탁 신호 없음';
  }

  return {
    gate: 'sources',
    pass,
    reason,
    evidence: {
      empty_url_refs: emptyUrlRefs,
      org_stat_hits: orgStatHits,
      has_valid_source: hasValidSource,
      score,
    },
  };
}

// ─── 진입점 ──────────────────────────────────────────────────────────────────

function main() {
  const draftPath = process.argv[2];
  if (!draftPath) {
    process.stderr.write('Usage: check-sources.mjs <draft.md>\n');
    process.exit(2);
  }

  let raw;
  try {
    raw = readFileSync(resolve(draftPath), 'utf8');
  } catch (e) {
    process.stderr.write(`check-sources: 파일 읽기 실패: ${e.message}\n`);
    process.exit(2);
  }

  const result = analyze(raw);

  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(result.pass ? 0 : 1);
}

// 단독 실행일 때만 main — 게이트16이 ORG_NAMES_RE 를 import 할 때 게이트가 따라 돌면 안 된다.
if (process.argv[1] && process.argv[1].endsWith('check-sources.mjs')) {
  main();
}
