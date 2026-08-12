/**
 * hub/store-supabase.mjs — store.mjs 와 동일 인터페이스의 Supabase 저장 어댑터
 *
 * 계약(§D2, plan §7):
 *   - appendRecord(type,data) · readRecords(type,{limit}) · timeline({limit,types}) · latest(type)
 *     를 store.mjs 와 동일하게 제공한다(단, Supabase I/O 특성상 async).
 *   - 크리덴셜(SUPABASE_URL + SUPABASE_SERVICE_ROLE) 없으면 store.mjs(JSONL)로 폴백.
 *   - 서버롤 키는 서버에서만 사용(클라이언트 미노출). 쓰기는 서버롤, RLS 가 anon 쓰기 차단.
 *
 * 테이블 매핑: briefing→hub_briefings, message→hub_messages,
 *             command→hub_commands, decision→hub_decisions.
 * 각 테이블 스키마: id text pk, ts timestamptz, data jsonb(전체 레코드).
 * data 에 평면 레코드({id,type,ts,...})를 통째로 저장 → 읽기 시 JSONL 과 동일 형태 복원.
 */

import { randomBytes } from 'node:crypto';
import * as jsonl from './store.mjs';
import { env } from '../lib/config.mjs';
import { makeLogger } from '../lib/log.mjs';

const log = makeLogger('hub/store-supabase');

export const RECORD_TYPES = jsonl.RECORD_TYPES;

const TABLE = Object.freeze({
  briefing: 'hub_briefings',
  message: 'hub_messages',
  command: 'hub_commands',
  decision: 'hub_decisions',
});

// ─── 크리덴셜 감지 ────────────────────────────────────────────────────────────

/** isSupabaseEnabled() — 서버롤 쓰기 크리덴셜이 모두 있으면 true. */
export function isSupabaseEnabled() {
  return Boolean(env('SUPABASE_URL') && (env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_SERVICE_ROLE')));
}

function restRoot() {
  return `${env('SUPABASE_URL').replace(/\/$/, '')}/rest/v1`;
}

function headers(extra = {}) {
  const key = (env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_SERVICE_ROLE'));
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...extra,
  };
}

function makeId(type) {
  return `${type}-${randomBytes(6).toString('hex')}`;
}

// ─── Supabase 구현 ────────────────────────────────────────────────────────────

async function sbAppend(type, data = {}) {
  if (!RECORD_TYPES.includes(type)) {
    throw new Error(`hub/store-supabase: 알 수 없는 레코드 종류 '${type}'`);
  }
  const record = {
    id: data.id || makeId(type),
    type,
    ts: data.ts || new Date().toISOString(),
    ...data,
  };
  record.type = type;

  const res = await fetch(`${restRoot()}/${TABLE[type]}`, {
    method: 'POST',
    headers: headers({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ id: record.id, ts: record.ts, data: record }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`supabase append ${type} → ${res.status} ${await res.text().catch(() => '')}`);
  }
  return record;
}

async function sbRead(type, { limit = 0 } = {}) {
  if (!RECORD_TYPES.includes(type)) {
    throw new Error(`hub/store-supabase: 알 수 없는 레코드 종류 '${type}'`);
  }
  let query = `${restRoot()}/${TABLE[type]}?select=data&order=ts.desc`;
  if (limit > 0) query += `&limit=${limit}`;
  const res = await fetch(query, { headers: headers(), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    log.warn(`supabase read ${type} → ${res.status}`);
    return [];
  }
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) ? rows.map((r) => r.data).filter(Boolean) : [];
}

async function sbTimeline({ limit = 0, types = RECORD_TYPES } = {}) {
  const merged = [];
  for (const type of types) {
    if (!RECORD_TYPES.includes(type)) continue;
    merged.push(...(await sbRead(type)));
  }
  merged.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return limit > 0 ? merged.slice(0, limit) : merged;
}

async function sbLatest(type) {
  const rows = await sbRead(type, { limit: 1 });
  return rows[0] || null;
}

// ─── 어댑터 선택 ──────────────────────────────────────────────────────────────

/**
 * getStore() → 동일 인터페이스 어댑터(async)
 * 크리덴셜 있으면 Supabase, 없으면 store.mjs(JSONL) 폴백.
 * 폴백 시에도 호출부 일관성을 위해 sync 함수를 Promise 로 감싼다.
 */
export function getStore() {
  if (isSupabaseEnabled()) {
    return {
      backend: 'supabase',
      appendRecord: sbAppend,
      readRecords: sbRead,
      timeline: sbTimeline,
      latest: sbLatest,
    };
  }
  return {
    backend: 'jsonl',
    appendRecord: async (type, data) => jsonl.appendRecord(type, data),
    readRecords: async (type, opts) => jsonl.readRecords(type, opts),
    timeline: async (opts) => jsonl.timeline(opts),
    latest: async (type) => jsonl.latest(type),
  };
}

// ─── 동일 시그니처 직접 export (어댑터 자동 선택) ─────────────────────────────

export async function appendRecord(type, data) {
  return getStore().appendRecord(type, data);
}
export async function readRecords(type, opts) {
  return getStore().readRecords(type, opts);
}
export async function timeline(opts) {
  return getStore().timeline(opts);
}
export async function latest(type) {
  return getStore().latest(type);
}
