/**
 * hub/store.mjs — CEO 소통 창고 공유 저장소
 * append-only JSONL 백엔드. 4종 레코드(briefing·message·command·decision)를
 * state/hub/<type>.jsonl 에 시간순 누적. 채팅·웹 대시보드 두 표면이 같은 데이터를 본다.
 *
 * 설계 원칙:
 *   - append-only (기존 행 수정 금지) — 감사로그 철학과 동일
 *   - STATE_DIR_OVERRIDE 로 경로 격리 가능 (테스트가 실제 state/ 를 건드리지 않음)
 *   - stdlib 전용, 외부 의존성 없음
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { paths } from '../lib/config.mjs';
import { makeLogger } from '../lib/log.mjs';

const log = makeLogger('hub/store');

/** 창고가 다루는 레코드 종류 */
export const RECORD_TYPES = Object.freeze(['briefing', 'message', 'command', 'decision']);

// ─── 경로 ─────────────────────────────────────────────────────────────────────

/** 창고 저장 루트 (state/hub). STATE_DIR_OVERRIDE 존중. */
function hubDir() {
  const dir = join(paths.state, 'hub');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function recordPath(type) {
  return join(hubDir(), `${type}.jsonl`);
}

// ─── id 생성 ──────────────────────────────────────────────────────────────────

function makeId(type) {
  return `${type}-${randomBytes(6).toString('hex')}`;
}

// ─── 공개 API ─────────────────────────────────────────────────────────────────

/**
 * appendRecord(type, data) → 기록된 레코드
 * id·ts 자동 부여. type 검증.
 */
export function appendRecord(type, data = {}) {
  if (!RECORD_TYPES.includes(type)) {
    throw new Error(`hub/store: 알 수 없는 레코드 종류 '${type}' (허용: ${RECORD_TYPES.join(', ')})`);
  }
  const record = {
    id:   data.id || makeId(type),
    type,
    ts:   data.ts || new Date().toISOString(),
    ...data,
  };
  // 중복 키 방지: type/id/ts 는 위에서 확정값 사용
  record.type = type;

  try {
    appendFileSync(recordPath(type), JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    log.error(`레코드 append 실패 (${type})`, err);
    throw err;
  }
  return record;
}

/**
 * readRecords(type, {limit}) → 레코드[] (시간 역순, 최신 우선)
 * 파일 없으면 빈 배열. 손상된 줄은 건너뛴다.
 */
export function readRecords(type, { limit = 0 } = {}) {
  if (!RECORD_TYPES.includes(type)) {
    throw new Error(`hub/store: 알 수 없는 레코드 종류 '${type}'`);
  }
  const p = recordPath(type);
  if (!existsSync(p)) return [];

  let content;
  try {
    content = readFileSync(p, 'utf8').trimEnd();
  } catch (err) {
    log.warn(`레코드 읽기 실패 (${type})`, err);
    return [];
  }
  if (!content) return [];

  const out = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // 손상된 줄 무시
    }
  }
  out.reverse(); // 최신 우선
  return limit > 0 ? out.slice(0, limit) : out;
}

/**
 * timeline({limit, types}) → 통합 레코드[] (ts 역순)
 * 4종(또는 지정 types)을 합쳐 단일 시간순 타임라인으로 반환.
 */
export function timeline({ limit = 0, types = RECORD_TYPES } = {}) {
  const merged = [];
  for (const type of types) {
    if (!RECORD_TYPES.includes(type)) continue;
    merged.push(...readRecords(type));
  }
  merged.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return limit > 0 ? merged.slice(0, limit) : merged;
}

/** latest(type) → 가장 최근 1건 또는 null */
export function latest(type) {
  const rows = readRecords(type, { limit: 1 });
  return rows[0] || null;
}

// ─── CLI (디버그) ─────────────────────────────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('store.mjs')) {
  const cmd = process.argv[2] || 'timeline';
  if (cmd === 'timeline') {
    console.log(JSON.stringify(timeline({ limit: 20 }), null, 2));
  } else if (RECORD_TYPES.includes(cmd)) {
    console.log(JSON.stringify(readRecords(cmd, { limit: 20 }), null, 2));
  } else {
    console.log(`사용법: node store.mjs [timeline|${RECORD_TYPES.join('|')}]`);
  }
}
