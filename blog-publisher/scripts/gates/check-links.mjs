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


import { runGateCli, GateError, loadGateConfig } from './lib/gate-cli.mjs';
import { isMainModule } from '../lib/main-module.mjs';
const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, '../../');

const LINK_TIMEOUT_MS = 10_000;

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

/**
 * 내부·사설 대상 판정(SSRF 차단, 2026-08-19).
 *
 * 이 게이트는 초안의 링크를 **우리 박스에서** HEAD 요청한다. 초안은 LLM 이 외부 수집물을 보고
 * 쓴 것이라 링크는 신뢰할 수 없는 입력이다. 예전엔 주소를 가리지 않아 `http://127.0.0.1:8787`
 * 같은 내부 주소도 그대로 조회했고, 성공/실패 상태코드가 게이트 evidence 에 남아 내부 서비스의
 * 존재 여부가 드러났다(블라인드 SSRF·내부 포트 스캔). 공개 블로그의 링크 생존 확인에 사설망
 * 주소가 필요할 일은 없으므로 기능 손실 없이 막는다.
 *
 * 이 파일은 다른 게이트와 같이 `main()` 을 무조건 실행하는 CLI 계약이라 import 대상이 아니다
 * (import 하면 게이트가 그대로 돌아 exit 한다) → export 하지 않는다. 검증은 CLI 를 통해서 한다:
 * scripts/test/link-ssrf.test.mjs 가 픽스처 초안으로 이 판정을 확인한다.
 *
 * @returns {string|null} 차단 사유(차단 시) 또는 null(허용)
 */
function blockedTarget(url) {
  let u;
  try { u = new URL(url); } catch { return '주소 형식 오류'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `허용 안 된 프로토콜(${u.protocol})`;
  let host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    return '내부 호스트명';
  }
  if (host === '::1' || host === '0.0.0.0' || host === '::') return '루프백/와일드카드';
  // IPv6 사설·링크로컬 (2026-08-19 리뷰 F3): `::` 는 0.0.0.0 의 대응물인데 빠져 있었고,
  // ULA(fc00::/7)·링크로컬(fe80::/10)도 IPv4 사설망과 같은 이유로 막아야 한다.
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return '사설망(IPv6 ULA fc00::/7)';
  if (/^fe[89ab][0-9a-f]:/.test(host)) return '링크로컬(IPv6 fe80::/10)';
  // IPv4-mapped IPv6(::ffff:127.0.0.1 / ::ffff:7f00:1) → IPv4 로 환원해서 같은 규칙을 적용한다.
  const mapped = /^::ffff:(.+)$/.exec(host);
  if (mapped) {
    const rest = mapped[1];
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) host = rest;
    else if (/^[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(rest)) {
      const [hi, lo] = rest.split(':').map(x => parseInt(x, 16));
      host = [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
    }
  }
  // 십진수·16진수 단일 토큰 표기(http://2130706433, http://0x7f000001)는 정상 링크에 쓰이지 않는다.
  // (WHATWG URL 파서가 대부분 127.0.0.1 로 정규화해 아래 규칙에 걸리지만, 파서 동작에만 기대지
  //  않도록 남겨 둔다. 8진 라벨 규칙은 007.example.com 같은 정상 도메인을 오차단해 뺐다.)
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/.test(host)) return '비표준 IP 표기(우회 시도)';
  // IPv4 리터럴만 판정한다(도메인은 DNS 결과까지 못 보므로 여기서는 리터럴 차단이 목적).
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    const [a, b] = m.slice(1).map(Number);
    if (a === 127) return '루프백(127/8)';
    if (a === 10) return '사설망(10/8)';
    if (a === 172 && b >= 16 && b <= 31) return '사설망(172.16/12)';
    if (a === 192 && b === 168) return '사설망(192.168/16)';
    if (a === 169 && b === 254) return '링크로컬/메타데이터(169.254/16)';
    if (a === 0) return '예약(0/8)';
    if (a === 100 && b >= 64 && b <= 127) return 'CGNAT(100.64/10)';   // 리뷰 F3
  }
  return null;
}

/** HEAD 요청 — 2xx 여부 반환 */
async function checkUrl(url) {
  const blocked = blockedTarget(url);
  if (blocked) return { url, status: null, ok: false, error: `차단(SSRF 방어): ${blocked}` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LINK_TIMEOUT_MS);
  try {
    // 리다이렉트를 수동으로 따라간다 — redirect:'follow' 로 두면 공개 도메인에서 내부 주소로
    // 튕기는 응답을 그대로 쫓아가 위 검사가 무의미해진다(가장 흔한 SSRF 필터 우회).
    let target = url, res = null;
    for (let hop = 0; hop <= 5; hop++) {
      res = await fetch(target, { method: 'HEAD', signal: controller.signal, redirect: 'manual' });
      if (res.status < 300 || res.status >= 400) break;
      const loc = res.headers.get('location');
      if (!loc) break;
      const next = new URL(loc, target).href;
      const blockedHop = blockedTarget(next);
      if (blockedHop) return { url, status: null, ok: false, error: `차단(SSRF 방어·리다이렉트): ${blockedHop}` };
      if (hop === 5) return { url, status: null, ok: false, error: '리다이렉트 5회 초과' };
      target = next;
    }
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

export async function evaluate(draftPath) {

  let raw;
  try {
    raw = readFileSync(resolve(draftPath), 'utf8');
  } catch (e) {
    throw new GateError(`파일 읽기 실패: ${e.message}`, { cause: e });
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

  return result;
}

// CLI 로 직접 실행될 때만 돈다. 가드가 없으면 run-all-gates 가 import 하는 순간
// 이 게이트가 stdout 을 쓰고 process.exit 해 버린다(2026-08-21 실측).
if (isMainModule(import.meta.url)) {
  await runGateCli({
    gate: 'links',
    evaluate,
    usage: 'Usage: check-links.mjs <draft.md>',
  });
}