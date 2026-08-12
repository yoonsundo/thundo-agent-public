#!/usr/bin/env node
/**
 * source-extract.mjs — 선정 주제의 원문 발췌(excerpt) 결정론 추출기 (ralplan v6 S1)
 *
 * 왜: 수집은 제목·URL 에서 멈추고 본문이 작가에게 도달하지 않아, 작가 LLM 이 구체 수치를
 * 내부지식으로 지어낸다. 이 스크립트가 원문 발췌를 **결정론으로** 공급한다(LLM 이 옮겨적지
 * 않는다 — 조용한 누락·변조 여지 제거).
 *
 * 사용: node scripts/lib/source-extract.mjs --selection runs/<date>/topics/selection.json
 *   (daily-runbook STEP 2 직후 — selection 은 STEP 2 산출물이라 선행조건 성립)
 *
 * 동작:
 *   selection[].pool_index → 같은 디렉토리 pool.json 항목 → sources[].url
 *   → 도메인 allowlist 검사(밖이면 시도 자체 금지 — Jina 는 대상 ToS 를 세탁하지 않는다)
 *   → Jina Reader(https://r.jina.ai/<url>) 로 본문 추출 (Agent-Reach web 채널 패턴)
 *      실패 시 재시도 1회 후 드롭 — 2차 HTML 파싱 폴백 없음(파서 없는 환경에서
 *      폴백은 네비·광고 노이즈 주입이 된다: 아키텍트 리뷰 F8)
 *   → 정제(코드펜스·frontmatter 구분선·HTML 태그·제어문자) + 8KB 절단
 *   → runs/<date>/sources/<writer>.json 저장 + pool 항목에 excerpt_file 기입
 *      (pool 은 읽기→병합→쓰기 — 기존 필드 보존, 전체 덮어쓰기 금지)
 *   → runs/<date>/run.json 에 excerpt_coverage 멱등 기입(관측 — 조용한 무력화 방지)
 *
 * 계약: RUN_MODE=mock → 결정론 합성(네트워크 0회). config 부재·손상 → 내장 기본값 degrade.
 *       enabled:false → 스킵(비차단). exit 0=정상(부분 실패 포함) / 2=사용법 오류.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { makeLogger } from './log.mjs';

const log = makeLogger('source-extract');

const CONFIG_PATH = 'config/source-pack.json';

/** 내장 기본값 — config 부재/손상 시 이 값으로 degrade(발행 차단 금지: 아키텍트 must-fix 3). */
export const DEFAULTS = Object.freeze({
  enabled: true,
  allow_domains: ['reddit.com', 'news.ycombinator.com', 'github.com', 'arxiv.org'],
  max_bytes: 8192,
  timeout_ms: 15000,
  retries: 1,
  max_urls_per_topic: 3,
});

export function loadSourcePackConfig(path = CONFIG_PATH) {
  try { return { ...DEFAULTS, ...JSON.parse(readFileSync(path, 'utf8')) }; }
  catch { return { ...DEFAULTS }; }
}

/** allowlist 판정 — host 가 도메인과 같거나 그 서브도메인일 때만 true. 순수. */
export function isAllowedUrl(url, allowDomains) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return (allowDomains || []).some(d => {
    const dom = String(d).toLowerCase();
    return host === dom || host === `www.${dom}` || host.endsWith(`.${dom}`);
  });
}

/**
 * 발췌 정제 — 프롬프트/frontmatter/렌더 통로 주입 방어. 순수.
 * 코드펜스 라인·`---` 단독 라인(frontmatter 경계 위조)·HTML 태그·제어문자 제거.
 */
export function sanitizeExcerpt(text, maxBytes = DEFAULTS.max_bytes) {
  let t = String(text ?? '')
    .replace(/```[^\n]*/g, ' ')
    .replace(/^---\s*$/gm, ' ')
    .replace(/<[^>\n]{0,200}>/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // 바이트 기준 절단 — 멀티바이트 경계는 Buffer 로 안전 처리
  const buf = Buffer.from(t, 'utf8');
  if (buf.length > maxBytes) t = buf.subarray(0, maxBytes).toString('utf8').replace(/�+$/, '');
  return t;
}

/** 결정론 해시 — mock 합성용. */
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

async function fetchViaJina(url, cfg) {
  const res = await fetch(`https://r.jina.ai/${url}`, {
    signal: AbortSignal.timeout(cfg.timeout_ms),
    headers: { 'User-Agent': 'blog-publisher-source-extract' },
  });
  if (!res.ok) throw new Error(`jina HTTP ${res.status}`);
  return await res.text();
}

/** 단건 추출: 재시도 1회 후 드롭(null). mock 은 결정론 합성. */
export async function extractOne(url, cfg, { mock = process.env.RUN_MODE === 'mock', fetchImpl = fetchViaJina } = {}) {
  if (mock) {
    return sanitizeExcerpt(
      `Mock excerpt for ${url}. 예시 통계: 응답시간 ${hashStr(url) % 900}ms, 사용자 ${hashStr(url + 'u') % 5000}명. ` +
      '이 텍스트는 RUN_MODE=mock 결정론 합성이다.', cfg.max_bytes);
  }
  for (let attempt = 0; attempt <= (cfg.retries ?? 1); attempt++) {
    try {
      const raw = await fetchImpl(url, cfg);
      const clean = sanitizeExcerpt(raw, cfg.max_bytes);
      if (clean.length < 80) throw new Error('본문이 사실상 비어 있음');
      return clean;
    } catch (e) {
      if (attempt >= (cfg.retries ?? 1)) { log.warn(`추출 드롭 ${url}: ${e.message}`); return null; }
    }
  }
  return null;
}

/** run.json 에 excerpt_coverage 멱등 기입(record-gate 패턴 — 다른 필드 보존). */
function upsertRunCoverage(runDir, coverage) {
  const p = join(runDir, 'run.json');
  let run = {};
  try { run = JSON.parse(readFileSync(p, 'utf8')); } catch { run = { date: runDir.split('/').pop() }; }
  run.excerpt_coverage = coverage;
  writeFileSync(p, JSON.stringify(run, null, 2));
}

export async function runExtract(selectionPath, { cfg = loadSourcePackConfig(), fetchImpl } = {}) {
  const topicsDir = dirname(selectionPath);              // runs/<date>/topics
  const runDir = dirname(topicsDir);                     // runs/<date>
  const selection = JSON.parse(readFileSync(selectionPath, 'utf8'));
  const poolPath = join(topicsDir, 'pool.json');
  const pool = JSON.parse(readFileSync(poolPath, 'utf8'));

  const sourcesDir = join(runDir, 'sources');
  mkdirSync(sourcesDir, { recursive: true });

  let withUrl = 0, extracted = 0;
  const dropped = [];

  for (const sel of selection) {
    const writer = sel.writer;
    const item = pool[sel.pool_index];
    if (!writer || !item) { dropped.push({ writer, reason: 'selection↔pool 미매칭' }); continue; }

    const urls = (item.sources || []).map(s => s.url).filter(Boolean).slice(0, cfg.max_urls_per_topic);
    if (urls.length === 0) continue; // url 없는 항목(cheetah 자기지식)은 coverage 분모 제외

    withUrl++;
    const entries = [];
    for (const url of urls) {
      if (!isAllowedUrl(url, cfg.allow_domains)) {
        // 🔴 allowlist 밖 — 시도 자체 금지(로그로 운영 리뷰 대상만 남긴다)
        dropped.push({ writer, url, reason: 'allowlist-밖' });
        continue;
      }
      const excerpt = await extractOne(url, cfg, fetchImpl ? { fetchImpl } : {});
      if (excerpt) entries.push({ url, title: (item.sources || []).find(s => s.url === url)?.title ?? '', excerpt, via: 'jina', fetched_at: new Date().toISOString() });
      else dropped.push({ writer, url, reason: 'fetch-실패' });
    }

    if (entries.length > 0) {
      const packPath = join(sourcesDir, `${writer}.json`);
      writeFileSync(packPath, JSON.stringify({ writer, topic: item.topic, generated_at: new Date().toISOString(), entries }, null, 2));
      // pool 병합 — 기존 필드 보존(전체 덮어쓰기 금지: Critic 실행 주의점)
      item.excerpt_file = packPath;
      extracted++;
    }
  }

  writeFileSync(poolPath, JSON.stringify(pool, null, 2));
  const coverage = `${extracted}/${withUrl}`;
  upsertRunCoverage(runDir, coverage);
  return { ok: true, coverage, extracted, dropped };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('source-extract.mjs')) {
  const i = process.argv.indexOf('--selection');
  const selectionPath = i > -1 ? process.argv[i + 1] : null;
  if (!selectionPath || !existsSync(selectionPath)) {
    console.error('사용: node scripts/lib/source-extract.mjs --selection runs/<date>/topics/selection.json');
    process.exit(2);
  }
  const cfg = loadSourcePackConfig();
  if (!cfg.enabled) {
    console.log(JSON.stringify({ ok: true, skipped: 'disabled' }));
    process.exit(0);
  }
  runExtract(selectionPath, { cfg })
    .then(r => { log.info(`완료 coverage=${r.coverage} 드롭=${r.dropped.length}`); console.log(JSON.stringify(r)); process.exit(0); })
    .catch(e => { log.error(`실행오류: ${e.message}`); console.log(JSON.stringify({ ok: false, error: e.message })); process.exit(0); }); // 추출 실패는 발행을 막지 않는다(원칙 3)
}
