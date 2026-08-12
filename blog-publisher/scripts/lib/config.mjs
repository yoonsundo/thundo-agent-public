/**
 * lib/config.mjs — 환경·설정 로더
 * .env(있으면) + config/*.json 로드, RUN_MODE 결정.
 * 크리덴셜 없으면 자동으로 mock 모드.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

// ─── 네트워크: IPv4 폴백 강제 (Happy Eyeballs) ───────────────────────────────
// 일부 호스트(WSL 등)는 IPv6 경로가 블랙홀이라, node fetch가 AAAA를 먼저 잡고
// ETIMEDOUT으로 멈춘다(curl은 IPv4 폴백). telegram·discord·supabase 알림이 fetch라
// 여기서 autoSelectFamily를 켜고 시도 타임아웃을 짧게 잡아 IPv6 실패 시 즉시 IPv4로 폴백.
net.setDefaultAutoSelectFamily(true);
net.setDefaultAutoSelectFamilyAttemptTimeout(500);

// ─── 경로 기준점 ──────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const SCRIPTS_DIR = resolve(__filename, '../../');
const ROOT_DIR    = resolve(SCRIPTS_DIR, '../');
const CONFIG_DIR  = join(ROOT_DIR, 'config');

// ─── .env 로더 (외부 의존성 없이 파싱) ───────────────────────────────────────
function loadDotEnv() {
  const envPath = join(ROOT_DIR, '.env');
  if (!existsSync(envPath)) return {};
  const text = readFileSync(envPath, 'utf8');
  const result = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && val) result[key] = val;
  }
  return result;
}

// ─── JSON 설정 로더 ───────────────────────────────────────────────────────────
function loadJson(name) {
  const p = join(CONFIG_DIR, name);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

// ─── 초기화 ──────────────────────────────────────────────────────────────────
const dotenv = loadDotEnv();

// process.env 우선, .env 보완 (기존 env 덮어쓰지 않음)
for (const [k, v] of Object.entries(dotenv)) {
  if (!(k in process.env)) process.env[k] = v;
}

// ─── RUN_MODE 결정 로직 ──────────────────────────────────────────────────────
// 크리덴셜이 하나라도 없으면 mock 자동 전환
const LIVE_CREDENTIALS = [
  'GITHUB_TOKEN',
  'VERCEL_TOKEN',
  'SUPABASE_ANON_KEY',
];

function detectRunMode() {
  const explicit = process.env.RUN_MODE;
  if (explicit === 'live') {
    const missing = LIVE_CREDENTIALS.filter(k => !process.env[k]);
    if (missing.length > 0) {
      console.warn(
        `[config] RUN_MODE=live 요청이나 크리덴셜 누락(${missing.join(', ')}) → mock 전환`
      );
      return 'mock';
    }
    return 'live';
  }
  if (explicit === 'mock') return 'mock';

  // 명시 없음 → 크리덴셜 있으면 live, 없으면 mock
  const anyCredential = LIVE_CREDENTIALS.some(k => process.env[k]);
  return anyCredential ? 'live' : 'mock';
}

export const RUN_MODE = detectRunMode();

/**
 * isCollectLive() — 수집 어댑터(Reddit RSS, HN)의 live 여부.
 * COLLECT_LIVE=1 환경변수 또는 RUN_MODE=live 일 때 true.
 * LLM/발행 크리덴셜과 독립적 — 공개 GET 전용 수집은 크리덴셜 불필요.
 */
export function isCollectLive() {
  if (process.env.COLLECT_LIVE === '1') return true;
  return RUN_MODE === 'live';
}

// ─── 설정 캐시 ───────────────────────────────────────────────────────────────
let _pipeline = null;
let _niche    = null;
let _budget   = null;
let _subreddits = null;

/** pipeline.json 로드 (캐시) */
export function loadPipeline() {
  if (!_pipeline) _pipeline = loadJson('pipeline.json');
  return _pipeline;
}

/** niche.json 로드 (캐시) */
export function loadNiche() {
  if (!_niche) _niche = loadJson('niche.json');
  return _niche;
}

/** budget.json 로드 (캐시) */
export function loadBudget() {
  if (!_budget) _budget = loadJson('budget.json');
  return _budget;
}

/** subreddits.json 로드 (캐시) */
export function loadSubreddits() {
  if (!_subreddits) _subreddits = loadJson('subreddits.json');
  return _subreddits;
}

/** mock 모드 여부 */
export function isMock() {
  return RUN_MODE === 'mock';
}

/** 경로 헬퍼
 * RUNS_DIR_OVERRIDE, STATE_DIR_OVERRIDE 환경변수로 테스트 격리 지원.
 * 테스트에서 임시 경로를 주입해 실제 state/runs를 보호할 수 있다.
 */
export const paths = {
  root:    ROOT_DIR,
  scripts: SCRIPTS_DIR,
  config:  CONFIG_DIR,
  // mock 격리: mock 런이 live 런 산출물(run.json·budget·lock·수집 raw)을 덮어쓰지 않도록
  // .mock-out/runs 로 분리 (.gitignore의 mock 산출물 규약). RUNS_DIR_OVERRIDE가 항상 우선.
  runs:    process.env.RUNS_DIR_OVERRIDE  || (RUN_MODE === 'mock' ? join(ROOT_DIR, '.mock-out', 'runs') : join(ROOT_DIR, 'runs')),
  state:   process.env.STATE_DIR_OVERRIDE || join(ROOT_DIR, 'state'),
  // 커버 이미지 스테이징 — 디자이너(쓰기)→blog-db(읽기) 임시 창고.
  // 최종 이미지는 Supabase blog_posts 에 data URI 로 박히므로 휘발성(.gitignore).
  images:  process.env.IMAGES_DIR_OVERRIDE || join(process.env.STATE_DIR_OVERRIDE || join(ROOT_DIR, 'state'), 'images'),
  // 감사체인 격리: 테스트·검증 런이 운영 해시체인(.omc/audit)에 append 하지 않도록 분리.
  // scripts/test/hub.mjs 가 이 변수를 설정해 왔으나 읽는 곳이 없어 실제로는 운영 체인을
  // 오염시키고 있었다(2026-07-23 수정). 이전 검증 런 격리에도 동일 계약을 쓴다.
  audit:   process.env.AUDIT_DIR_OVERRIDE || join(ROOT_DIR, '.omc', 'audit'),
  mockOut: join(ROOT_DIR, '.mock-out'),
};

/** 환경변수 읽기 헬퍼 (누락 시 mock 전용 기본값 반환) */
export function env(key, fallback = '') {
  return process.env[key] ?? fallback;
}

// ─── 모드 출력 ───────────────────────────────────────────────────────────────
if (process.env.CONFIG_VERBOSE === '1') {
  console.log(`[config] RUN_MODE=${RUN_MODE}`);
}
