#!/usr/bin/env node
/**
 * check-source-fidelity.mjs — 게이트 16: 소스 사실 대조 (ralplan v6 S3)
 *
 * 무엇을 막나: 작가 LLM 이 "맥킨지에 따르면 40%" 처럼 **외부 기관에 귀속시킨 수치를
 * 지어내는 것**. excerpt(원문 발췌, source-extract 산출)와 결정론 대조한다.
 * 1인칭 경험 수치("제가 재보니 3분")는 대조 제외 — 게이트 9(credibility)·10(density)이
 * 요구하는 경험 수치를 여기서 차단하면 게이트 교착이 된다(아키텍트 조건 1).
 *
 * 조인(Critic F1 — 실재 필드만): 초안 frontmatter `writer`
 *   → 초안 경로의 runs/<date>/topics/selection.json ({writer, pool_index})
 *   → pool.json[pool_index].excerpt_file. `topic_id` 는 LLM 이 지어내는 슬러그라 금지.
 *
 * 5상태:
 *   1 no-pack        skip-pass — selection/pool 없음(또는 항목에 excerpt 없음) + 초안에 source_pack 없음
 *                    (evolve-tmp·benchmark/seed·published·mock run-lion 초안이 전부 여기 — fitness 비오염)
 *   2 pack-ignored   fail — pool 에 excerpt 있는데 작가가 source_pack 미기록(게으른 작가)
 *   3 pack-lost      fail — source_pack 경로가 있는데 파일 부재/파싱 불가
 *   4 pack-unresolved fail — selection 은 있는데 writer 항목 미매칭(매칭 실패≠통과)
 *   5 정상 대조:
 *     (a) 외부 귀속 수치(기관명 ORG_NAMES_RE 또는 귀속 구문 동반 문장 내 수치)가 excerpt 에
 *         미실재 ≥2건 → fail (1건은 토크나이즈 오차 허용)
 *     (b) 표절: 초안↔excerpt 문자 4-gram Jaccard > 0.107(게이트12 차용) 또는 연속 일치 ≥40자 → fail
 *
 * shadow(S3a): config `gate_enforce:false`(기본) — 판정은 항상 pass 로 내리되 evidence 에
 * 실제 판정(shadow_verdict)을 남긴다. 캘리브레이션+1주 관찰 후 S3b 에서 true.
 *
 * 계약: stdout JSON 1줄 {gate, pass, reason, evidence} · exit 0=통과/1=실패.
 * config 부재·손상은 내장 기본값 degrade — **exit 2 를 내지 않는다**(run-all-gates 는
 * stdout 부재를 pass:false 로 집계하므로 config 사고가 전편 차단이 되면 안 된다: 아키텍트 must-fix 3).
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join, sep } from 'node:path';
import { ORG_NAMES_RE } from './check-sources.mjs';

import { isMainModule } from '../lib/main-module.mjs';

import { runGateCli, GateError } from './lib/gate-cli.mjs';
const GATE = 'source-fidelity';

// ── 임계 초기값 (캘리브레이션 드라이런으로 확정 — ralplan v6 M6) ───────────────
const UNMATCHED_MAX   = 1;      // 외부 귀속 미실재 수치 허용 상한(2건부터 fail)
const JACCARD_MAX     = 0.107;  // 게이트12(internal-dup)와 동일 축
const RUN_MATCH_CHARS = 40;     // 연속 일치 상한(자)

/** 귀속 구문 — 기관명 없이도 "…에 따르면/발표/보고서/통계/조사" 문장은 외부 주장으로 본다(신규 패턴). */
export const ATTRIBUTION_RE = /(에\s*따르면|따르면|발표했|발표한|보고서|통계에|통계를|조사에서|조사 결과|연구에|연구 결과|리포트에)/;

/** 1인칭 경험 마커 — 이 문장의 수치는 대조 제외(게이트 9·10 의 영역). */
export const FIRST_PERSON_RE = /(제가|저는|저의|내가|나는|직접\s*(해|써|재|돌려)|실제로\s*(해|써|돌려)|테스트해\s*보)/;

/** frontmatter 파싱(관대) — writer, source_pack 만 필요. 순수. */
export function parseFm(raw) {
  const m = String(raw).match(/^---\n([\s\S]*?)\n---/);
  if (!m) return { fm: {}, body: String(raw) };
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*"?([^"\n]*)"?\s*$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return { fm, body: String(raw).slice(m[0].length) };
}

/** 문장 분리(대략) — 한국어 종결·개행 기준. 순수. */
function sentences(body) {
  return String(body).split(/(?<=[.!?다요죠음됨함])\s+|\n+/).map(s => s.trim()).filter(Boolean);
}

/** 외부 귀속 문장의 수치 토큰 추출. 순수. evidence 용으로 {num, sentence} 반환. */
export function externalStatTokens(body) {
  const out = [];
  for (const s of sentences(body)) {
    if (FIRST_PERSON_RE.test(s)) continue;                       // 1인칭 경험 제외
    if (!ORG_NAMES_RE.test(s) && !ATTRIBUTION_RE.test(s)) continue; // 외부 귀속만
    for (const m of s.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
      const num = m[0].replace(/,/g, '');
      if (num.length === 4 && /^(19|20)\d\d$/.test(num)) continue; // 연도는 수치 주장이 아님
      out.push({ num, sentence: s.slice(0, 80) });
    }
  }
  return out;
}

/** 수치가 excerpt 에 실재하는가 — 콤마 무시 정확 일치. 순수. */
export function statMatches(tokens, excerptText) {
  const hay = String(excerptText).replace(/,/g, '');
  const matched = [], unmatched = [];
  for (const t of tokens) (hay.includes(t.num) ? matched : unmatched).push(t);
  return { matched, unmatched };
}

/** 문자 4-gram Jaccard. 순수(게이트12와 같은 정의역). */
export function jaccard4(a, b) {
  const grams = (s) => {
    const t = String(s).replace(/\s+/g, ' ');
    const set = new Set();
    for (let i = 0; i + 4 <= t.length; i++) set.add(t.slice(i, i + 4));
    return set;
  };
  const A = grams(a), B = grams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

/** excerpt 의 40자 창이 초안에 그대로 존재하는가(연속 복사 탐지). 순수. */
export function longestRunAtLeast(draft, excerpt, runLen = RUN_MATCH_CHARS, step = 20) {
  const d = String(draft).replace(/\s+/g, ' ');
  const e = String(excerpt).replace(/\s+/g, ' ');
  for (let i = 0; i + runLen <= e.length; i += step) {
    if (d.includes(e.slice(i, i + runLen))) return true;
  }
  return false;
}

/** 초안 경로 → runs/<date> 디렉토리(없으면 null). 순수. */
export function runDirOf(draftPath) {
  const parts = resolve(draftPath).split(sep);
  const i = parts.lastIndexOf('runs');
  if (i === -1 || !parts[i + 1] || !/^\d{4}-\d{2}-\d{2}$/.test(parts[i + 1])) return null;
  return parts.slice(0, i + 2).join(sep);
}

function loadJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function loadConfig() {
  try {
    // ⚠ **의도적인 cwd 상대경로다.** 절대경로로 바꾸지 마라 —
    //   scripts/test/source-fidelity.test.mjs 의 [6] 이 격리된 cwd 에 자체
    //   config/source-pack.json 을 두고 shadow/enforce 분기를 검증한다.
    //   운영 cwd 는 항상 저장소 루트라(크론·npm run gate) 실제 위험은 없다.
    const c = JSON.parse(readFileSync('config/source-pack.json', 'utf8'));
    return { enforce: c.gate_enforce === true };
  } catch { return { enforce: false }; }   // 부재·손상 → shadow 로 degrade(발행 차단 금지)
}

/** 핵심 판정(순수 — 테스트가 직접 부른다). 반환 {pass, reason, evidence}. enforce 미적용 원판정. */
export function judge(raw, draftPath) {
  const { fm, body } = parseFm(raw);
  const runDir = runDirOf(draftPath);

  // source_pack 명시 경로 우선
  if (fm.source_pack) {
    const pack = loadJson(fm.source_pack);
    if (!pack || !Array.isArray(pack.entries) || pack.entries.length === 0) {
      return { pass: false, reason: 'pack-lost: source_pack 경로의 팩이 없거나 비어 있음', evidence: { reason: 'pack-lost', path: fm.source_pack } };
    }
    const excerptText = pack.entries.map(e => e.excerpt).join('\n');
    const tokens = externalStatTokens(body);
    const { matched, unmatched } = statMatches(tokens, excerptText);
    const jac = jaccard4(body, excerptText);
    const run40 = longestRunAtLeast(body, excerptText);
    const evidence = {
      reason: 'compared', matched_stats: matched.length, unmatched: unmatched.length,
      unmatched_samples: unmatched.slice(0, 3), jaccard: Number(jac.toFixed(4)), long_run: run40,
    };
    if (unmatched.length > UNMATCHED_MAX) {
      return { pass: false, reason: `외부 귀속 수치 ${unmatched.length}건이 발췌에 미실재(허용 ${UNMATCHED_MAX})`, evidence };
    }
    if (jac > JACCARD_MAX || run40) {
      return { pass: false, reason: `소스 표절 신호(jaccard=${evidence.jaccard}${run40 ? `, 연속≥${RUN_MATCH_CHARS}자` : ''})`, evidence };
    }
    return { pass: true, reason: `대조 통과 (귀속수치 ${matched.length}건 실재, 미실재 ${unmatched.length}건)`, evidence };
  }

  // source_pack 없음 → selection ground truth 로 게으른 작가/매칭 실패 판별
  if (runDir) {
    const selection = loadJson(join(runDir, 'topics', 'selection.json'));
    const pool = loadJson(join(runDir, 'topics', 'pool.json'));
    if (Array.isArray(selection) && Array.isArray(pool) && fm.writer) {
      const sel = selection.find(s => s.writer === fm.writer);
      if (!sel) {
        return { pass: false, reason: `pack-unresolved: selection 에 writer=${fm.writer} 없음`, evidence: { reason: 'pack-unresolved' } };
      }
      const item = pool[sel.pool_index];
      if (item && item.excerpt_file) {
        return { pass: false, reason: 'pack-ignored: 발췌가 준비됐는데 초안이 source_pack 을 기록하지 않음', evidence: { reason: 'pack-ignored', excerpt_file: item.excerpt_file } };
      }
    }
  }
  return { pass: true, reason: 'no-pack: 발췌 없는 초안 — 대조 생략', evidence: { reason: 'no-pack' } };
}

// ── main ─────────────────────────────────────────────────────────────────────
export function evaluate(draftPath) {
  let raw;
  try { raw = readFileSync(resolve(draftPath), 'utf8'); }
  catch (e) { throw new GateError(`파일 읽기 실패: ${e.message}`, { cause: e }); }

  let verdict;
  try { verdict = judge(raw, draftPath); }
  catch (e) {
    // 예기치 못한 오류도 전편 차단으로 번지지 않게 skip 으로 degrade(사유는 남긴다)
    verdict = { pass: true, reason: `error-degrade: ${e.message}`, evidence: { reason: 'error' } };
  }

  const { enforce } = loadConfig();
  const result = enforce
    ? { gate: GATE, ...verdict }
    : { gate: GATE, pass: true, reason: verdict.pass ? verdict.reason : `shadow(미집행): ${verdict.reason}`,
        evidence: { ...verdict.evidence, shadow_verdict: verdict.pass ? 'pass' : 'fail' } };

  return result;
}

if (isMainModule(import.meta.url)) {
  await runGateCli({
    gate: 'source-fidelity',
    evaluate,
  });
}
