#!/usr/bin/env node
/**
 * scripts/test/design.mjs — 이미지 디자이너/심사관 통합 테스트
 *
 * 검증 항목:
 *   a) 후보 2개 생성(designClaude+designGemini, mock) → judgeImages → winner 1장 보장
 *   b) 공정성: gemini alt/brief 적합도 높인 케이스 → winner.by==='gemini' (포맷편향·자기채점 없음)
 *   c) imageGate: 치수·alt길이 위반 후보 → pass:false
 *   d) 비차단 폴백: 후보 0개(둘다 null) → judge winner=null (파이프라인 비차단 확인)
 *   e) 예산 image축 스킵: chargeImage 캡 소진 후 checkImageBudget().ok===false
 *   f) judgeToRunJson 형태 확인 (by/authority/candidates/tiebreak/reproducible)
 *
 * 격리: 임시 파일 + budget 상태 스냅샷/복원으로 실제 state 보호.
 * exit 0 = 전부 통과 / exit 1 = 1개 이상 실패
 */

import {
  mkdtempSync, rmSync, writeFileSync,
  existsSync, readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── 환경: mock 모드 강제 (크리덴셜 불필요) ────────────────────────────────────
process.env.RUN_MODE = 'mock';

import { designClaude }                           from '../design/claude-designer.mjs';
import { designGemini }                           from '../design/gemini-designer.mjs';
import { judgeImages, imageGate, judgeToRunJson } from '../design/judge.mjs';
import { paths }                                  from '../lib/config.mjs';

// ─── 유틸 ─────────────────────────────────────────────────────────────────────

let passCount = 0;
let failCount = 0;

function pass(label) {
  console.log(`  [PASS] ${label}`);
  passCount++;
}

function fail(label, detail = '') {
  console.error(`  [FAIL] ${label}${detail ? ': ' + detail : ''}`);
  failCount++;
}

// ─── 임시 디렉토리 ────────────────────────────────────────────────────────────

const TMP_DIR = mkdtempSync(join(tmpdir(), 'design-test-'));

/** 테스트용 더미 SVG 파일 생성 후 절대경로 반환 (imageGate 파일존재 검사 통과용) */
function tmpSvg(name) {
  const p = join(TMP_DIR, `${name}.svg`);
  writeFileSync(
    p,
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"/>',
    'utf8',
  );
  return p;
}

// ─── budget 스냅샷/복원 헬퍼 ─────────────────────────────────────────────────

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function budgetFilePath() {
  return join(paths.runs, todayStr(), 'budget.json');
}

function snapshotBudget() {
  const p = budgetFilePath();
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

function restoreBudget(snapshot) {
  const p = budgetFilePath();
  if (snapshot === null) {
    if (existsSync(p)) rmSync(p, { force: true });
  } else {
    writeFileSync(p, snapshot, 'utf8');
  }
}

// ─── 공통 픽스처 ──────────────────────────────────────────────────────────────

const topic = {
  id:    'topic-test-design',
  title: 'AI 자동화 블로그 파이프라인 구축',
};

const draft = {
  id:    'draft-test-design',
  slug:  'test-design-slug',
  title: topic.title,
};

// ─── a) 후보 2개 생성 → judgeImages → winner 1장 보장 ────────────────────────
console.log('\n[a] 후보 생성 + judgeImages winner 보장');
{
  const cCand = await designClaude(topic, draft);
  const gCand = await designGemini(topic, draft);

  if (cCand && cCand.by === 'claude') {
    pass('a-1 designClaude 후보 생성 (by=claude, path 존재)');
  } else {
    fail('a-1 designClaude 후보 생성', `by=${cCand?.by}, path=${cCand?.path}`);
  }

  if (gCand && gCand.by === 'gemini') {
    pass('a-2 designGemini 후보 생성 (by=gemini, path 존재)');
  } else {
    fail('a-2 designGemini 후보 생성', `by=${gCand?.by}, path=${gCand?.path}`);
  }

  const result = await judgeImages([cCand, gCand].filter(Boolean), draft);
  if (result?.winner !== null && typeof result?.winner?.by === 'string') {
    pass(`a-3 judgeImages winner 1장 보장 (by=${result.winner.by})`);
  } else {
    fail('a-3 judgeImages winner 1장 보장', `winner=${JSON.stringify(result?.winner)}`);
  }
}

// ─── b) 공정성: gemini alt/brief 높이면 winner.by==='gemini' ─────────────────
// mockImageJudge는 by 필드를 채점에 사용하지 않고 alt+brief 토큰 ↔ 제목 토큰 Jaccard로 판정.
// gemini 후보에 제목 토큰을 고밀도로 포함하면 gemini가 이겨야 한다.
console.log('\n[b] 공정성 — gemini 적합도 우세 시 winner.by===gemini');
{
  const svgPath = tmpSvg('fairness');

  // claude: alt/brief 에 제목 토큰('ai','자동화','블로그','파이프라인','구축') 거의 없음
  const claudeFair = {
    by:     'claude',
    format: 'svg',
    path:   svgPath,
    alt:    '단순 배경 커버 이미지 디자인 레이아웃 구성',  // 제목 토큰 미포함
    brief:  'claude 디자이너: 차분한 배경, 간결한 시각 구성',
    meta:   { w: 1200, h: 630 },
  };

  // gemini: alt/brief 에 제목 토큰 고밀도 → Jaccard 상승
  const geminiFair = {
    by:     'gemini',
    format: 'svg',
    path:   svgPath,
    alt:    'AI 자동화 블로그 파이프라인 구축 커버 이미지',
    brief:  'AI 자동화 블로그 파이프라인 구축 워크플로우 자동화 블로그',
    meta:   { w: 1200, h: 630 },
  };

  const result = await judgeImages([claudeFair, geminiFair], draft);
  if (result?.winner?.by === 'gemini') {
    pass('b-1 gemini 적합도 우세 → winner.by===gemini (포맷편향·자기채점 없음)');
  } else {
    fail(
      'b-1 gemini 적합도 우세 → winner.by===gemini',
      `실제 winner.by=${result?.winner?.by}, scores=${JSON.stringify(result?.scores)}`,
    );
  }
}

// ─── c) imageGate: 치수·alt길이 위반 → pass:false ────────────────────────────
console.log('\n[c] imageGate 위반 후보 → pass:false');
{
  const svgPath = tmpSvg('gate-test');

  // 치수 위반: meta.w=800 (규격 1200~1600 벗어남)
  const widthViolation = {
    by:     'claude',
    format: 'svg',
    path:   svgPath,
    alt:    'AI 자동화 블로그 파이프라인 커버 이미지',
    brief:  'claude 커버 이미지',
    meta:   { w: 800, h: 630 },
  };
  const r1 = imageGate(widthViolation);
  if (!r1.pass && r1.reasons.some(r => r.includes('meta.w'))) {
    pass('c-1 치수 위반(w=800) → pass:false, meta.w 사유 포함');
  } else {
    fail('c-1 치수 위반 → pass:false', `pass=${r1.pass}, reasons=${JSON.stringify(r1.reasons)}`);
  }

  // alt 길이 위반: 5자 (최소 10자 필요)
  const altViolation = {
    by:     'gemini',
    format: 'svg',
    path:   svgPath,
    alt:    '짧은alt',  // 5자
    brief:  'gemini 커버 이미지 디자인 결과물',
    meta:   { w: 1200, h: 630 },
  };
  const r2 = imageGate(altViolation);
  if (!r2.pass && r2.reasons.some(r => r.includes('alt 길이'))) {
    pass('c-2 alt 길이 위반(5자) → pass:false, alt 길이 사유 포함');
  } else {
    fail('c-2 alt 길이 위반 → pass:false', `pass=${r2.pass}, reasons=${JSON.stringify(r2.reasons)}`);
  }
}

// ─── d) 비차단 폴백: 후보 0개 → winner=null ──────────────────────────────────
// judgeImages는 차단권 없음 — 후보 0개여도 winner=null을 반환하고 파이프라인 계속.
console.log('\n[d] 비차단 폴백 — 후보 0개 → winner=null');
{
  // null 두 개 → judgeImages 내부에서 filter(Boolean) → valid=[] → winner=null
  const result = await judgeImages([null, null], draft);

  if (result !== null && result !== undefined && result.winner === null) {
    pass('d-1 후보 0개 → winner=null (파이프라인 비차단)');
  } else {
    fail('d-1 후보 0개 → winner=null', `result=${JSON.stringify(result)}`);
  }

  // result 객체 완전성: authority, gate, reproducible 필드 존재해야 함
  if (
    result &&
    typeof result.authority    === 'string' &&
    Array.isArray(result.gate) &&
    typeof result.reproducible === 'boolean'
  ) {
    pass('d-2 winner=null 시 result 완전성 (authority/gate/reproducible 존재)');
  } else {
    fail('d-2 winner=null 시 result 완전성', JSON.stringify(result));
  }
}

// ─── e) 예산 image축 스킵: chargeImage 소진 후 checkImageBudget().ok===false ──
// BUDGET_IMAGE_CALLS_DAILY=1 → 캡 1. chargeImage(0,1) 후 ok=false 를 확인.
// budget 상태는 테스트 전후 스냅샷/복원으로 격리.
console.log('\n[e] 예산 image축 스킵 — chargeImage 소진 후 ok===false');
{
  const budgetSnap = snapshotBudget();
  // budget.json 초기화 (fresh state: image_calls_used=0)
  const budgetPath = budgetFilePath();
  if (existsSync(budgetPath)) rmSync(budgetPath, { force: true });

  // image 콜 캡을 1로 축소 (getCaps()가 호출 시점에 env 읽음 → 정적 import 후에도 유효)
  const origCap = process.env.BUDGET_IMAGE_CALLS_DAILY;
  process.env.BUDGET_IMAGE_CALLS_DAILY = '1';

  try {
    // budget.mjs는 이 파일의 정적 import 목록에 없으므로 dynamic import 사용.
    // getCaps()는 chargeImage/checkImageBudget 호출 시점에 env를 재읽으므로 캡 축소 반영됨.
    const { chargeImage, checkImageBudget } = await import('../watchdog/budget.mjs');

    // 1회 충전 → image_calls_used=1, cap=1 → over_cap=true
    chargeImage(0, 1, 'test-e');
    const br = checkImageBudget();

    if (br.ok === false) {
      pass(`e-1 chargeImage 캡 소진(calls=1/1) → checkImageBudget().ok===false`);
    } else {
      fail(
        'e-1 chargeImage 캡 소진 → ok===false',
        `ok=${br.ok}, image_calls_used=${br.image_calls_used}, cap=${br.caps?.image?.calls}`,
      );
    }
  } finally {
    // 환경변수·budget 파일 복원
    if (origCap === undefined) {
      delete process.env.BUDGET_IMAGE_CALLS_DAILY;
    } else {
      process.env.BUDGET_IMAGE_CALLS_DAILY = origCap;
    }
    restoreBudget(budgetSnap);
  }
}

// ─── f) judgeToRunJson 형태 확인 ──────────────────────────────────────────────
console.log('\n[f] judgeToRunJson 형태 확인');
{
  const svgPath = tmpSvg('tojson');
  const a = {
    by:     'claude',
    format: 'svg',
    path:   svgPath,
    alt:    'AI 자동화 블로그 파이프라인 커버 이미지',
    brief:  'claude 디자이너: AI 자동화 파이프라인 구축',
    meta:   { w: 1200, h: 630 },
  };
  const b = {
    by:     'gemini',
    format: 'svg',
    path:   svgPath,
    alt:    '블로그 자동화 파이프라인 커버 이미지 디자인',
    brief:  'gemini 디자이너: 블로그 자동화 파이프라인',
    meta:   { w: 1200, h: 630 },
  };

  const judgeResult = await judgeImages([a, b], draft);
  const runJson     = judgeToRunJson(judgeResult);

  // 최상위 필드 5종 존재 확인
  const hasBy           = 'by'           in runJson;
  const hasAuthority    = 'authority'    in runJson;
  const hasCandidates   = Array.isArray(runJson.candidates);
  const hasTiebreak     = 'tiebreak'     in runJson;
  const hasReproducible = 'reproducible' in runJson;

  if (hasBy && hasAuthority && hasCandidates && hasTiebreak && hasReproducible) {
    pass(
      `f-1 judgeToRunJson 필드 완전성` +
      ` (by=${runJson.by}, authority=${runJson.authority}, candidates=${runJson.candidates.length})`,
    );
  } else {
    fail('f-1 judgeToRunJson 필드 완전성', JSON.stringify(runJson));
  }

  // candidates 각 항목: { by:string, score, gate_pass:boolean }
  const candidatesValid = runJson.candidates.length > 0 &&
    runJson.candidates.every(
      c => typeof c.by === 'string' && 'score' in c && typeof c.gate_pass === 'boolean',
    );
  if (candidatesValid) {
    pass('f-2 candidates 항목 형태 ({by, score, gate_pass}) 확인');
  } else {
    fail('f-2 candidates 항목 형태', JSON.stringify(runJson.candidates));
  }
}

// ─── 정리 + 결과 출력 ─────────────────────────────────────────────────────────

// 임시 파일 정리 (TMP_DIR + 디자이너가 state/images 에 남긴 테스트 자산)
try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
for (const by of ['claude', 'gemini', 'webp']) {
  for (const ext of ['svg', 'webp']) {
    try {
      const p = join(paths.images, `test-design-slug.${by}.${ext}`);
      if (existsSync(p)) rmSync(p, { force: true });
    } catch { /* 무시 */ }
  }
}

console.log(`\n${'─'.repeat(50)}`);
console.log(`[design] 결과: ${passCount} 통과 / ${failCount} 실패`);

if (failCount > 0) {
  process.exit(1);
}
