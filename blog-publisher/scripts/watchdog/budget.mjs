/**
 * watchdog/budget.mjs — 토큰/콜 예산 카운터
 * runs/<date>/budget.json 누적, 캡 초과 판정.
 * §D2-watchdog + budget.json config 기반.
 * 엣지케이스: budget.json 손상/없음, runs 디렉터리 쓰기 실패 — graceful 처리.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { paths, loadBudget, env } from '../lib/config.mjs';
import { makeLogger } from '../lib/log.mjs';

const log = makeLogger('watchdog/budget');

// ─── 경로 ─────────────────────────────────────────────────────────────────────

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function budgetPath(date = todayStr()) {
  const dir = join(paths.runs, date);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'budget.json');
}

// ─── 상태 로드/저장 ──────────────────────────────────────────────────────────

function freshState(date) {
  return {
    date,
    tokens_used: 0,
    calls_used:  0,
    // 이미지 디자이너(Gemini image API) 전용 별도 예산 축 — Max구독 토큰/콜 축과 독립.
    image_tokens_used: 0,
    image_calls_used:  0,
    events:      [],
    created_at:  new Date().toISOString(),
    updated_at:  new Date().toISOString(),
  };
}

function loadState(date = todayStr()) {
  const p = budgetPath(date);
  if (!existsSync(p)) return freshState(date);
  try {
    const raw   = readFileSync(p, 'utf8');
    const state = JSON.parse(raw);
    // 필수 필드 검증
    if (typeof state.tokens_used !== 'number' || typeof state.calls_used !== 'number') {
      log.warn('budget.json 구조 손상 — 초기화');
      return freshState(date);
    }
    // image 축 하위호환: 기존 budget.json엔 없으므로 누락 시 0으로 보정.
    if (typeof state.image_tokens_used !== 'number') state.image_tokens_used = 0;
    if (typeof state.image_calls_used  !== 'number') state.image_calls_used  = 0;
    return state;
  } catch (err) {
    log.warn('budget.json 파싱 실패 — 초기화', err);
    return freshState(date);
  }
}

function saveState(state, date = todayStr()) {
  const p = budgetPath(date);
  state.updated_at = new Date().toISOString();
  try {
    writeFileSync(p, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    log.error('budget.json 저장 실패', err);
  }
}

// ─── 캡 읽기 ─────────────────────────────────────────────────────────────────

function getCaps() {
  let config;
  try {
    config = loadBudget();
  } catch {
    config = null;
  }
  const cap = config?.daily_hard_cap || {};
  const imageCap = cap.image || {};
  return {
    tokens: parseInt(env('BUDGET_TOKENS_DAILY', String(cap.tokens || 1_000_000)), 10),
    calls:  parseInt(env('BUDGET_CALLS_DAILY',  String(cap.agent_calls || 80)), 10),
    // image 축: Gemini image API 호출 별도 캡(기본 10콜·200k토큰). config.daily_hard_cap.image 우선.
    image: {
      tokens: parseInt(env('BUDGET_IMAGE_TOKENS_DAILY', String(imageCap.tokens || 200_000)), 10),
      calls:  parseInt(env('BUDGET_IMAGE_CALLS_DAILY',  String(imageCap.calls  || 10)), 10),
    },
  };
}

// ─── 공개 API ─────────────────────────────────────────────────────────────────

/**
 * charge(tokens, calls, label) → { tokens_used, calls_used, over_cap, caps }
 * 사용량 누적 후 캡 초과 여부 반환.
 * 캡 초과 시 warn 로그 출력.
 */
export function charge(tokens = 0, calls = 1, label = 'unknown') {
  const date  = todayStr();
  const state = loadState(date);
  const caps  = getCaps();

  state.tokens_used += tokens;
  state.calls_used  += calls;
  state.events.push({
    ts:             new Date().toISOString(),
    label,
    tokens,
    calls,
    running_tokens: state.tokens_used,
    running_calls:  state.calls_used,
  });

  saveState(state, date);

  const over_cap = state.tokens_used >= caps.tokens || state.calls_used >= caps.calls;
  if (over_cap) {
    log.warn(`예산 캡 초과 — tokens=${state.tokens_used}/${caps.tokens} calls=${state.calls_used}/${caps.calls} (label=${label})`);
  }

  return {
    tokens_used: state.tokens_used,
    calls_used:  state.calls_used,
    over_cap,
    caps,
  };
}

/**
 * checkBudget() → { ok, tokens_used, calls_used, caps, remaining }
 * ok=false → 파이프라인 중단 권고.
 */
export function checkBudget() {
  const date  = todayStr();
  const state = loadState(date);
  const caps  = getCaps();

  const ok = state.tokens_used < caps.tokens && state.calls_used < caps.calls;

  return {
    ok,
    tokens_used: state.tokens_used,
    calls_used:  state.calls_used,
    caps,
    remaining: {
      tokens: Math.max(0, caps.tokens - state.tokens_used),
      calls:  Math.max(0, caps.calls  - state.calls_used),
    },
  };
}

/**
 * chargeImage(tokens, calls, label) → { image_tokens_used, image_calls_used, over_cap, caps }
 * 이미지 디자이너(Gemini API) 전용 별도 예산 축에 누적. Max 토큰/콜 축과 독립.
 * over_cap=true → 래스터 생성만 스킵(글·SVG 발행은 영향 없음).
 */
export function chargeImage(tokens = 0, calls = 1, label = 'image') {
  const date  = todayStr();
  const state = loadState(date);
  const caps  = getCaps();

  state.image_tokens_used += tokens;
  state.image_calls_used  += calls;
  state.events.push({
    ts:    new Date().toISOString(),
    label: `image:${label}`,
    image_tokens: tokens,
    image_calls:  calls,
    running_image_tokens: state.image_tokens_used,
    running_image_calls:  state.image_calls_used,
  });
  saveState(state, date);

  const over_cap = state.image_tokens_used >= caps.image.tokens ||
                   state.image_calls_used  >= caps.image.calls;
  if (over_cap) {
    log.warn(`이미지 예산 캡 초과 — img_tokens=${state.image_tokens_used}/${caps.image.tokens} img_calls=${state.image_calls_used}/${caps.image.calls} (label=${label})`);
  }
  return {
    image_tokens_used: state.image_tokens_used,
    image_calls_used:  state.image_calls_used,
    over_cap,
    caps,
  };
}

/**
 * checkImageBudget() → { ok, image_tokens_used, image_calls_used, caps, remaining }
 * image 축 사전점검. ok=false → 래스터 생성 스킵(파이프라인 중단 아님 — Max 축과 독립).
 */
export function checkImageBudget() {
  const date  = todayStr();
  const state = loadState(date);
  const caps  = getCaps();
  const ok = state.image_tokens_used < caps.image.tokens &&
             state.image_calls_used  < caps.image.calls;
  return {
    ok,
    image_tokens_used: state.image_tokens_used,
    image_calls_used:  state.image_calls_used,
    caps,
    remaining: {
      tokens: Math.max(0, caps.image.tokens - state.image_tokens_used),
      calls:  Math.max(0, caps.image.calls  - state.image_calls_used),
    },
  };
}

/**
 * getBudgetState(date?) → raw state object
 */
export function getBudgetState(date) {
  return loadState(date || todayStr());
}

// CLI
if (process.argv[1] && process.argv[1].endsWith('budget.mjs')) {
  const cmd = process.argv[2] || 'check';
  if (cmd === 'check') {
    console.log(JSON.stringify(checkBudget(), null, 2));
  } else if (cmd === 'charge') {
    const tokens = parseInt(process.argv[3] || '1000', 10);
    const calls  = parseInt(process.argv[4] || '1', 10);
    console.log(JSON.stringify(charge(tokens, calls, 'cli-test'), null, 2));
  }
}
