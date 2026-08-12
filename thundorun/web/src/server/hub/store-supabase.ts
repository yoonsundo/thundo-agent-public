/**
 * server/hub/store-supabase.ts — Supabase 어댑터 + JSONL 폴백 (store-supabase.mjs 이식)
 *
 * 인터페이스: appendRecord · readRecords · timeline · latest (모두 async).
 * 크리덴셜(NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) 있으면 Supabase 사용,
 * 없으면 store.ts(JSONL) 폴백.
 *
 * 테이블 매핑: briefing→hub_briefings, message→hub_messages,
 *             command→hub_commands, decision→hub_decisions.
 * 스키마: id text pk, ts timestamptz, data jsonb(전체 레코드).
 */
import { randomBytes } from 'crypto';
import * as jsonl from './store';
import { makeLogger } from './logger';
import { supabaseServiceKey } from './config';

export { RECORD_TYPES } from './store';
export type { HubRecord, RecordType } from './store';

const log = makeLogger('hub/store-supabase');

const TABLE: Record<string, string> = Object.freeze({
  briefing: 'hub_briefings',
  message:  'hub_messages',
  command:  'hub_commands',
  decision: 'hub_decisions',
});

// ─── 크리덴셜 감지 ────────────────────────────────────────────────────────────

export function isSupabaseEnabled(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && supabaseServiceKey()
  );
}

function restRoot(): string {
  return `${(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/$/, '')}/rest/v1`;
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const key = supabaseServiceKey();
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...extra,
  };
}

function makeId(type: string): string {
  return `${type}-${randomBytes(6).toString('hex')}`;
}

// ─── Supabase 구현 ────────────────────────────────────────────────────────────

async function sbAppend(type: string, data: Record<string, unknown> = {}): Promise<jsonl.HubRecord> {
  if (!(jsonl.RECORD_TYPES as readonly string[]).includes(type)) {
    throw new Error(`hub/store-supabase: 알 수 없는 레코드 종류 '${type}'`);
  }
  const record: jsonl.HubRecord = {
    id: (data.id as string) || makeId(type),
    type,
    ts: (data.ts as string) || new Date().toISOString(),
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
    const body = await res.text().catch(() => '');
    throw new Error(`supabase append ${type} → ${res.status} ${body.slice(0, 200)}`);
  }
  return record;
}

async function sbRead(type: string, { limit = 0 } = {}): Promise<jsonl.HubRecord[]> {
  if (!(jsonl.RECORD_TYPES as readonly string[]).includes(type)) {
    throw new Error(`hub/store-supabase: 알 수 없는 레코드 종류 '${type}'`);
  }
  let query = `${restRoot()}/${TABLE[type]}?select=data&order=ts.desc`;
  if (limit > 0) query += `&limit=${limit}`;

  const res = await fetch(query, { headers: headers(), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    log.warn(`supabase read ${type} → ${res.status}`);
    return [];
  }
  const rows = await res.json().catch(() => []) as Array<{ data: jsonl.HubRecord }>;
  return Array.isArray(rows) ? rows.map(r => r.data).filter(Boolean) : [];
}

async function sbTimeline({ limit = 0, types = jsonl.RECORD_TYPES as readonly string[] } = {}): Promise<jsonl.HubRecord[]> {
  const merged: jsonl.HubRecord[] = [];
  for (const type of types) {
    if (!(jsonl.RECORD_TYPES as readonly string[]).includes(type)) continue;
    merged.push(...await sbRead(type));
  }
  merged.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return limit > 0 ? merged.slice(0, limit) : merged;
}

async function sbLatest(type: string): Promise<jsonl.HubRecord | null> {
  const rows = await sbRead(type, { limit: 1 });
  return rows[0] ?? null;
}

// ─── 어댑터 선택 ──────────────────────────────────────────────────────────────

function getStore() {
  if (isSupabaseEnabled()) {
    return {
      backend: 'supabase' as const,
      appendRecord: sbAppend,
      readRecords: sbRead,
      timeline: sbTimeline,
      latest: sbLatest,
    };
  }
  return {
    backend: 'jsonl' as const,
    appendRecord: async (type: string, data?: Record<string, unknown>) => jsonl.appendRecord(type, data),
    readRecords:  async (type: string, opts?: { limit?: number }) => jsonl.readRecords(type, opts),
    timeline:     async (opts?: { limit?: number; types?: readonly string[] }) => jsonl.timeline(opts),
    latest:       async (type: string) => jsonl.latest(type),
  };
}

// ─── 직접 export (어댑터 자동 선택) ──────────────────────────────────────────

export async function appendRecord(type: string, data?: Record<string, unknown>): Promise<jsonl.HubRecord> {
  return getStore().appendRecord(type, data ?? {});
}
export async function readRecords(type: string, opts?: { limit?: number }): Promise<jsonl.HubRecord[]> {
  return getStore().readRecords(type, opts ?? {});
}
export async function timeline(opts?: { limit?: number; types?: readonly string[] }): Promise<jsonl.HubRecord[]> {
  return getStore().timeline(opts ?? {});
}
export async function latest(type: string): Promise<jsonl.HubRecord | null> {
  return getStore().latest(type);
}
