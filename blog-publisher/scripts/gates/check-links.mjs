#!/usr/bin/env node
/**
 * check-links.mjs — 마크다운 링크 생존 확인 + §C2 assertionGuard
 *
 * 1) 본문 마크다운 링크 추출 → HEAD 요청(timeout 10s) → 전부 2xx여야 통과
 *    (링크 0개면 통과)
 * 2) assertionGuard:
 *    - 문장 분리 후 단정문장(/[이다된다한다했다였다]\.?\s*$/) 판별
 *    - 단정문장 중 링크가 없는 것 = 무근거 단정
 *    - 비율 > 0.6 이면 fail
 *    - 의심 문장 최대 5개 evidence.assertion_sample
 *
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

const LINK_TIMEOUT_MS = 10_000;

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return { fact_gate: { unsourced_assertion_max_ratio: 0.6, assertion_sample_max: 5 } };
  }
}

/** YAML frontmatter 제거 후 본문 반환 */
function stripFrontmatter(text) {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return m ? m[1] : text;
}

/** 마크다운 링크 URL 추출 — [text](url) 형식만 (이미지 제외) */
function extractLinks(text) {
  const urls = [];
  // 인라인 링크: [text](url) — ![] 이미지 제외
  const re = /(?<!!)\[(?:[^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
  for (const m of text.matchAll(re)) {
    urls.push(m[1]);
  }
  // 레퍼런스 링크: [id]: url
  const refRe = /^\[(?:[^\]]+)\]:\s*(https?:\/\/\S+)/gm;
  for (const m of text.matchAll(refRe)) {
    urls.push(m[1]);
  }
  return [...new Set(urls)];
}

/** HEAD 요청 — 2xx 여부 반환 */
async function checkUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LINK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow',
    });
    return { url, status: res.status, ok: res.status >= 200 && res.status < 300 };
  } catch (e) {
    return { url, status: null, ok: false, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

/** 문장 분리 (한국어 문장 부호 기준) */
function splitSentences(text) {
  // 코드블록 제거
  const clean = text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm, '');
  // 마크다운 링크를 sentinel로 대체하여 분리 정확도 유지
  const sentences = [];
  for (const para of clean.split(/\n{2,}/)) {
    const trimmed = para.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('|') || trimmed.startsWith('-') || trimmed.startsWith('*')) continue;
    // 문장 분리: 마침표/느낌표/물음표 뒤 공백 또는 줄바꿈
    const parts = trimmed.split(/(?<=[.!?。])\s+/);
    for (const p of parts) {
      const s = p.trim();
      if (s.length > 10) sentences.push(s);
    }
  }
  return sentences;
}

/**
 * 단정문장 판별: 링크 없는 "사실 주장" 문장 탐지
 *
 * §C2 assertionGuard 목적: 근거 없이 사실을 단정하는 문장 비율 제한.
 * 일반 서사·경험·조언 문장은 제외하고, 수치·통계·절대적 사실 주장만 대상으로 함.
 *
 * 단정 조건 (모두 충족):
 *   1) 링크 없음 (https:// 포함 문장은 출처 있음)
 *   2) 수치/퍼센트/배수 포함 OR "항상/절대/반드시/무조건/모든/전부/결코" 등 절대어 포함
 *   3) 확인 가능한 외부 사실 어미: "~이다/~된다/~한다" 계열 (평서문 종결)
 *
 * 경험담·서사·조언("~해보자", "~할 수 있다", "~하면 된다")은 단정으로 보지 않음.
 */
function isAssertion(sentence) {
  // 링크 포함 문장 = 출처 있음
  if (/https?:\/\//.test(sentence)) return false;

  // 조언/가능성/권유 어미는 단정 아님
  if (/[해]보[자길]|할 수 있|하면 된다|해도 된|할 수도|수 있다|수 있어|겠지|일 것|것이다\s*[.。]?\s*$/.test(sentence)) return false;
  // 경험·추측 어미
  if (/것 같|보인다|느껴진다|들린다|생각한다|판단한다|예상한다/.test(sentence)) return false;

  // 수치·통계·절대어 포함 여부
  const hasQuantifier = /\d+\s*(%|퍼센트|배|명|개|건|회|년|달|시간|분|초|원|달러)|항상|절대|반드시|무조건|모든|전부|전혀|결코|100%|누구나|어디서나/.test(sentence);
  if (!hasQuantifier) return false;

  // 평서형 사실 주장 어미
  return /[이다된다한다했다였다않다없다있다합니다됩니다입니다]\s*[.。]?\s*$/.test(sentence);
}

async function main() {
  const draftPath = process.argv[2];
  if (!draftPath) {
    process.stderr.write('Usage: check-links.mjs <draft.md>\n');
    process.exit(2);
  }

  let raw;
  try {
    raw = readFileSync(resolve(draftPath), 'utf8');
  } catch (e) {
    process.stderr.write(`check-links: 파일 읽기 실패: ${e.message}\n`);
    process.exit(2);
  }

  const config = loadConfig();
  const MAX_UNSOURCED_RATIO = config?.fact_gate?.unsourced_assertion_max_ratio ?? 0.6;
  const SAMPLE_MAX = config?.fact_gate?.assertion_sample_max ?? 5;

  const body = stripFrontmatter(raw);

  // --- 링크 생존 검사 ---
  const urls = extractLinks(body);
  const linkResults = await Promise.all(urls.map(checkUrl));
  const alive = linkResults.filter(r => r.ok).map(r => r.url);
  const dead = linkResults.filter(r => !r.ok).map(r => ({ url: r.url, status: r.status, error: r.error }));

  // --- assertionGuard ---
  const sentences = splitSentences(body);
  const assertionSentences = sentences.filter(isAssertion);
  const unsourced_ratio = sentences.length > 0
    ? parseFloat((assertionSentences.length / sentences.length).toFixed(4))
    : 0;
  const assertion_sample = assertionSentences.slice(0, SAMPLE_MAX);

  // 통과 조건
  const linksPass = dead.length === 0;
  const assertionPass = unsourced_ratio <= MAX_UNSOURCED_RATIO;
  const pass = linksPass && assertionPass;

  const reasons = [];
  if (!linksPass) reasons.push(`죽은 링크 ${dead.length}개`);
  if (!assertionPass) reasons.push(`무근거 단정 비율 ${unsourced_ratio} > 상한 ${MAX_UNSOURCED_RATIO}`);
  if (pass) reasons.push(`링크 ${alive.length}/${urls.length} 생존, 무근거 단정 비율 ${unsourced_ratio} ≤ ${MAX_UNSOURCED_RATIO}`);

  const result = {
    gate: 'links',
    pass,
    reason: reasons.join('; '),
    evidence: {
      total: urls.length,
      alive: alive.length,
      dead,
      unsourced_ratio,
      assertion_sample,
    },
  };

  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(pass ? 0 : 1);
}

main();
