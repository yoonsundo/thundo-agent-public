#!/usr/bin/env node
/**
 * scripts/design/judge.mjs — 이미지 심사관 (Image Judge)
 *
 * 디자이너(claude/gemini) 후보 2장 중 초안에 더 어울리는 1장을 선택한다.
 * 발행 차단권 없음 — 글 발행은 별도 게이트13+검증자4가 결정.
 *
 * 미어켓 가드 준수:
 *   - judge_authority='llm' 시에도 후보의 by 필드를 LLM 입력에서 제거(blind)
 *   - 자기채점 금지 원칙 — 포맷/by 편향 없이 내용 기반 채점
 *   - judge 실패/동점이어도 항상 1장 보장(mockImageJudge 결정론 tiebreak)
 *
 * 후보 표준객체 계약:
 *   { by:'claude'|'gemini', format:'svg'|'webp', path:string, alt:string,
 *     brief:string, svg?:string, meta:{w,h,bytes,mock?,public?} }
 *
 * @module design/judge
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mockImageJudge } from '../lib/mock-llm.mjs';
import { isMock, loadPipeline, paths, env } from '../lib/config.mjs';
import { makeLogger } from '../lib/log.mjs';
import '../lib/force-subscription.mjs'; // 구독 강제(claude 직접 spawn 방어)

const __dir = dirname(fileURLToPath(import.meta.url));
const log   = makeLogger('design/judge');

// ─── LLM judge CLI (교차벤더: Gemini/agy 가 채점 — 미어켓 가드: blind + cross-vendor) ──
// designer가 Claude SVG를 만들므로, 자기채점 방지를 위해 채점은 다른 벤더(agy)로.
const AGY_DEFAULT_PATH = '/home/user/.local/bin/agy';
function resolveJudgeBin() {
  const explicit = env('IMAGE_JUDGE_BIN');
  if (explicit) return explicit;
  if (existsSync(AGY_DEFAULT_PATH)) return AGY_DEFAULT_PATH;
  return 'agy';
}
/** IMAGE_LIVE=1 또는 RUN_MODE=live 일 때 실제 LLM judge 사용. */
function judgeIsLive() {
  return env('IMAGE_LIVE') === '1' || !isMock();
}

// ─── banned-terms 패턴 로더 ───────────────────────────────────────────────────

/** banned-terms.txt 컴파일 결과 캐시 */
let _bannedPatterns = null;

/**
 * loadBannedPatterns() — config/banned-terms.txt 를 정규식 배열로 캐싱.
 * 파일 읽기 실패 시 빈 배열 반환(방어적 처리).
 * @returns {RegExp[]}
 */
function loadBannedPatterns() {
  if (_bannedPatterns) return _bannedPatterns;
  const p = join(paths.config, 'banned-terms.txt');
  const patterns = [];
  try {
    const raw = readFileSync(p, 'utf8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      try {
        patterns.push(new RegExp(t, 'u'));
      } catch {
        // 컴파일 실패 패턴은 조용히 건너뜀
      }
    }
  } catch (e) {
    log.warn('banned-terms.txt 로드 실패 — 금지어 검사 건너뜀', e);
  }
  _bannedPatterns = patterns;
  return _bannedPatterns;
}

// ─── 이미지 게이트 ────────────────────────────────────────────────────────────

/**
 * imageGate(candidate) — 결정론 이미지 유효성 필터.
 *
 * 검사 항목:
 *   1. 파일 존재 (candidate.path)
 *   2. 치수 meta.w 1200~1600
 *   3. 종횡비 w/h 가 1.91:1(±0.1) 또는 1:1(±0.1)
 *   4. alt 길이 10~125자
 *   5. alt+brief 에 banned-terms 패턴 없음
 *
 * 하나라도 위반 시 pass:false.
 *
 * @param {object} candidate 후보 표준객체
 * @returns {{ pass:boolean, reasons:string[] }}
 */
export function imageGate(candidate) {
  const reasons = [];

  if (!candidate || typeof candidate !== 'object') {
    return { pass: false, reasons: ['후보 객체 누락 또는 잘못된 타입'] };
  }

  // 1. 파일 존재
  if (!candidate.path || !existsSync(candidate.path)) {
    reasons.push(`파일 없음: ${candidate.path ?? '(path 미설정)'}`);
  }

  // 2. 치수 meta.w 1200~1600
  const w = candidate.meta?.w;
  const h = candidate.meta?.h;
  if (typeof w !== 'number' || w < 1200 || w > 1600) {
    reasons.push(`meta.w 범위 초과: ${w} (1200~1600 필요)`);
  }

  // 3. 종횡비 w/h — 1.91:1(±0.1) 또는 1:1(±0.1)
  if (typeof w === 'number' && typeof h === 'number' && h > 0) {
    const ratio = w / h;
    const ok191 = ratio >= 1.81 && ratio <= 2.01;
    const ok11  = ratio >= 0.9  && ratio <= 1.1;
    if (!ok191 && !ok11) {
      reasons.push(
        `종횡비 불일치: ${ratio.toFixed(3)} (1.91:1±0.1 또는 1:1±0.1 필요)`
      );
    }
  } else if (typeof h !== 'number' || h <= 0) {
    reasons.push(`meta.h 누락 또는 유효하지 않음: ${h}`);
  }

  // 4. alt 길이 10~125자
  const alt = typeof candidate.alt === 'string' ? candidate.alt : '';
  if (alt.length < 10 || alt.length > 125) {
    reasons.push(`alt 길이 범위 초과: ${alt.length}자 (10~125 필요)`);
  }

  // 5. alt+brief 에 banned-terms 패턴 없음
  const text = `${alt} ${candidate.brief ?? ''}`;
  for (const re of loadBannedPatterns()) {
    if (re.test(text)) {
      reasons.push(`금지어 검출: /${re.source}/`);
      break; // 첫 번째 위반만 보고 (이후 검사 불필요)
    }
  }

  return { pass: reasons.length === 0, reasons };
}

// ─── LLM judge (live 모드 전용) ───────────────────────────────────────────────

/**
 * callLlmJudge(validCandidates, draft) — LLM에 blind 채점 요청 (live 전용).
 *
 * blind 보장: 후보에서 by 필드를 완전히 제거한 입력만 LLM에 전달.
 *   전송: { format, alt, brief, meta:{w,h} }
 *   미전송: by (claude/gemini) — 자기채점 방지
 *
 * 호출 실패 또는 응답 파싱 오류 시 null 반환 → 호출자에서 결정론 폴백.
 *
 * @param {object[]} validCandidates 게이트 통과 후보 목록
 * @param {object}   draft           초안 객체
 * @returns {Promise<{ winner:object|null, scores:object[], tiebreak:boolean }|null>}
 */
async function callLlmJudge(validCandidates, draft) {
  const bin = resolveJudgeBin();

  // ── blind 입력 구성: by 필드 제거 + 실제 SVG 내용 포함 ───────────────────
  // 미어칫 가드: 후보의 by(claude/gemini)를 심사 LLM에 전달하지 않음(자기채점 금지).
  // 교차벤더(agy=Gemini)가 채점하며, 실제 이미지(SVG 마크업)를 보고 적합도를 판단한다.
  function svgOf(c) {
    let svg = c.svg || '';
    if (!svg && c.path && existsSync(c.path)) {
      try { svg = readFileSync(c.path, 'utf8'); } catch { svg = ''; }
    }
    // 전체 SVG를 보여줘야 공정(과도한 잘림은 '코드 중단'으로 오판→큰 디자인 불이익).
    // 일반 커버 SVG는 ~15KB 이하. 폭주 방지선만 넉넉히 둔다.
    return svg.length > 16000 ? svg.slice(0, 16000) + '\n<!-- (truncated) -->' : svg;
  }
  const blind = validCandidates.map((c, idx) => ({ idx, alt: c.alt, svg: svgOf(c) }));

  const title = draft?.title ?? '(제목 없음)';
  const prompt = [
    `당신은 블로그 커버 이미지 심사관입니다. 아래 글 제목에 시각적으로 가장 잘 어울리는`,
    `SVG 커버 후보를 고르세요. 디자인 완성도·가독성·주제 적합성을 종합 판단합니다.`,
    `글 제목: "${title}"`,
    ``,
    ...blind.flatMap(c => [
      `── 후보 [${c.idx}] (alt: ${c.alt}) ──`,
      '```svg',
      c.svg,
      '```',
    ]),
    ``,
    `가장 적합한 후보 번호(0부터)만 JSON 한 줄로 답하세요. 다른 말 금지:`,
    `{ "selected": <번호>, "reason": "<한 줄 이유>" }`,
  ].join('\n');

  // agy(Antigravity) vs gemini 인자 분기
  const isAgy = /agy$/.test(bin);
  const args = isAgy
    ? ['-p', prompt, '--dangerously-skip-permissions', '--print-timeout', '90s']
    : ['-p', prompt, '-o', 'text'];

  let res;
  try {
    res = spawnSync(bin, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  } catch (e) {
    log.warn(`LLM judge CLI(${bin}) 실행 예외 — 폴백: ${e.message}`);
    return null;
  }
  if (res.error) { log.warn(`LLM judge CLI(${bin}) 사용 불가 — 폴백: ${res.error.message}`); return null; }

  const text = `${res.stdout || ''}`;
  const match = text.match(/\{[\s\S]*?\}/);
  if (!match) { log.warn('LLM judge 응답 JSON 파싱 실패 — 폴백'); return null; }

  let parsed;
  try { parsed = JSON.parse(match[0]); } catch { log.warn('LLM judge JSON 파싱 예외 — 폴백'); return null; }
  const sel = Number(parsed.selected);
  if (!Number.isInteger(sel) || sel < 0 || sel >= validCandidates.length) {
    log.warn(`LLM judge 선택 인덱스 범위 초과(${sel}) — 폴백`);
    return null;
  }

  const winner = validCandidates[sel];
  const scores = validCandidates.map((c, i) => ({ by: c.by, score: i === sel ? 1.0 : 0.0 }));
  log.info(`LLM judge 선택 완료(${isAgy ? 'antigravity' : bin}): idx=${sel}, by=${winner.by} — ${String(parsed.reason || '').slice(0, 60)}`);
  return { winner, scores, tiebreak: false, reason: parsed.reason || null };
}

// ─── 메인 judge ───────────────────────────────────────────────────────────────

/**
 * judgeImages(candidates, draft, opts) — 이미지 심사 메인 함수.
 *
 * 흐름:
 *   1. 각 후보에 imageGate 적용 → 통과 후보(valid) 필터
 *   2. valid=0 → winner=null
 *   3. valid=1 → 단독 winner
 *   4. valid≥2 → authority 에 따라 결정론 또는 LLM judge
 *      - deterministic: mockImageJudge(결정론, blind)
 *      - llm + mock모드: mockImageJudge 사용, authority='llm' 표기
 *      - llm + live모드: callLlmJudge(blind) → 실패 시 mockImageJudge 폴백
 *
 * @param {object[]} candidates 후보 표준객체 배열
 * @param {object}   draft      초안 객체 (title 등)
 * @param {object}   [opts={}]  확장 옵션 (현재 미사용)
 * @returns {Promise<{
 *   winner: object|null,
 *   authority: 'llm'|'deterministic',
 *   scores: Array<{by:string, score:number}>,
 *   tiebreak: boolean,
 *   gate: Array<{by:string, pass:boolean, reasons:string[]}>,
 *   reproducible: boolean
 * }>}
 */
export async function judgeImages(candidates, draft, opts = {}) {
  const all = (candidates || []).filter(Boolean);

  // 게이트 결과 수집
  const gateResults = all.map(c => {
    const { pass, reasons } = imageGate(c);
    return { by: c.by ?? '(unknown)', pass, reasons };
  });

  // 통과 후보만 추출
  const valid = all.filter((_, i) => gateResults[i].pass);

  // 0개 → winner=null, 항상 반환(차단권 없음)
  if (valid.length === 0) {
    log.warn('모든 후보 게이트 실패 — winner=null (발행은 별도 게이트가 결정)');
    return {
      winner:       null,
      authority:    'deterministic',
      scores:       [],
      tiebreak:     false,
      gate:         gateResults,
      reproducible: true,
    };
  }

  // 1개 → 단독 winner (tiebreak 불필요)
  if (valid.length === 1) {
    log.info(`게이트 통과 후보 1개 — winner: ${valid[0].by}`);
    return {
      winner:       valid[0],
      authority:    'deterministic',
      scores:       [{ by: valid[0].by, score: 1.0 }],
      tiebreak:     false,
      gate:         gateResults,
      reproducible: true,
    };
  }

  // 2개 이상 → authority 결정
  const pipelineConf   = loadPipeline();
  const authority      = pipelineConf?.image?.judge_authority || 'deterministic';

  // ── deterministic 경로 ───────────────────────────────────────────────────
  if (authority === 'deterministic') {
    const { winner, scores, tiebreak } = mockImageJudge(valid, draft);
    log.info(`결정론 judge — winner: ${winner?.by}, tiebreak: ${tiebreak}`);
    return {
      winner,
      authority:    'deterministic',
      scores,
      tiebreak,
      gate:         gateResults,
      reproducible: true,
    };
  }

  // ── llm 경로 ─────────────────────────────────────────────────────────────
  if (!judgeIsLive()) {
    // IMAGE_LIVE 미설정 mock: 결정론 대체, authority='llm' 표기 (크리덴셜 불필요)
    const { winner, scores, tiebreak } = mockImageJudge(valid, draft);
    log.info(`llm authority(mock 모드) — 결정론 대체, winner: ${winner?.by}`);
    return {
      winner,
      authority:    'llm',
      scores,
      tiebreak,
      gate:         gateResults,
      reproducible: false, // LLM 비결정 표기(mock이어도 의도는 llm)
    };
  }

  // 실제 LLM judge (IMAGE_LIVE=1 또는 live) — 교차벤더 agy, blind, SVG 내용 기반
  log.info('LLM judge 시작 (live, blind, 교차벤더)');
  const llmResult = await callLlmJudge(valid, draft);

  if (llmResult) {
    return {
      winner:       llmResult.winner,
      authority:    'llm',
      scores:       llmResult.scores,
      tiebreak:     llmResult.tiebreak,
      gate:         gateResults,
      reproducible: false,
    };
  }

  // LLM 실패 → 결정론 폴백 (authority 의도는 'llm' 유지)
  log.warn('LLM judge 실패 — 결정론 폴백');
  const { winner, scores, tiebreak } = mockImageJudge(valid, draft);
  return {
    winner,
    authority:    'llm',
    scores,
    tiebreak,
    gate:         gateResults,
    reproducible: false,
  };
}

// ─── run.json 직렬화 ──────────────────────────────────────────────────────────

/**
 * judgeToRunJson(result) — judgeImages 결과를 run.json 기록용 객체로 변환.
 *
 * @param {object} result judgeImages 반환값
 * @returns {{
 *   by: string|null,
 *   authority: string,
 *   score: number|null,
 *   candidates: Array<{by:string, score:number|null, gate_pass:boolean}>,
 *   tiebreak: boolean,
 *   reproducible: boolean
 * }}
 */
export function judgeToRunJson(result) {
  if (!result) {
    return {
      by: null, authority: 'deterministic', score: null,
      candidates: [], tiebreak: false, reproducible: true,
    };
  }

  const { winner, authority, scores, tiebreak, gate, reproducible } = result;

  // 게이트 결과 기준으로 후보 목록 생성 — score 병합
  const candidates = (gate || []).map(g => {
    const scoreEntry = (scores || []).find(s => s.by === g.by);
    return {
      by:        g.by,
      score:     scoreEntry?.score ?? null,
      gate_pass: g.pass,
    };
  });

  const winnerScore = winner
    ? ((scores || []).find(s => s.by === winner.by)?.score ?? null)
    : null;

  return {
    by:           winner?.by ?? null,
    authority:    authority ?? 'deterministic',
    score:        winnerScore,
    candidates,
    tiebreak:     tiebreak ?? false,
    reproducible: reproducible ?? true,
  };
}

// ─── CLI 자가 시연 ────────────────────────────────────────────────────────────

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
  const tmpDir = '/tmp/judge-demo';
  mkdirSync(tmpDir, { recursive: true });

  const p1 = `${tmpDir}/demo-claude.svg`;
  const p2 = `${tmpDir}/demo-gemini.svg`;
  writeFileSync(p1, '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"/>');
  writeFileSync(p2, '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"/>');

  const draft = { title: 'AI 자동화 블로그 파이프라인 실전 구축' };
  const a = {
    by: 'claude', format: 'svg', path: p1,
    alt:   'AI 자동화 커버 이미지 — 파이프라인 구조 도식',
    brief: 'claude 디자인: 간결한 텍스트 중심 레이아웃',
    meta:  { w: 1200, h: 630 },
  };
  const b = {
    by: 'gemini', format: 'webp', path: p2,
    alt:   'AI 자동화 블로그 파이프라인 핵심 개념 커버',
    brief: 'gemini AI 자동화 블로그 파이프라인 워크플로우',
    meta:  { w: 1200, h: 630 },
  };

  console.log('─── imageGate ───');
  console.log('a:', JSON.stringify(imageGate(a)));
  console.log('b:', JSON.stringify(imageGate(b)));

  console.log('\n─── judgeImages ───');
  const result = await judgeImages([a, b], draft);
  console.log('winner:', result.winner?.by);
  console.log('authority:', result.authority);
  console.log('reproducible:', result.reproducible);
  console.log('tiebreak:', result.tiebreak);
  console.log('scores:', result.scores);

  console.log('\n─── judgeToRunJson ───');
  console.log(JSON.stringify(judgeToRunJson(result), null, 2));

  rmSync(tmpDir, { recursive: true, force: true });
}
