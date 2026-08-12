/**
 * server/hub/store.ts — JSONL append-only 저장소 (store.mjs 이식)
 * 4종 레코드(briefing·message·command·decision)를 state/hub/<type>.jsonl 에 누적.
 * dev 폴백용. Vercel 프로덕션에서는 store-supabase.ts 가 Supabase를 사용.
 */
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { paths } from './config';
import { makeLogger } from './logger';

const log = makeLogger('hub/store');

export const RECORD_TYPES = Object.freeze(['briefing', 'message', 'command', 'decision'] as const);
export type RecordType = typeof RECORD_TYPES[number];

export interface HubRecord {
  id: string;
  type: string;
  ts: string;
  [key: string]: unknown;
}

function hubDir(): string {
  const dir = path.join(paths.state, 'hub');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function recordPath(type: string): string {
  return path.join(hubDir(), `${type}.jsonl`);
}

function makeId(type: string): string {
  return `${type}-${randomBytes(6).toString('hex')}`;
}

export function appendRecord(type: string, data: Record<string, unknown> = {}): HubRecord {
  if (!(RECORD_TYPES as readonly string[]).includes(type)) {
    throw new Error(`hub/store: 알 수 없는 레코드 종류 '${type}'`);
  }
  const record: HubRecord = {
    id: (data.id as string) || makeId(type),
    type,
    ts: (data.ts as string) || new Date().toISOString(),
    ...data,
  };
  record.type = type;

  try {
    appendFileSync(recordPath(type), JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    log.error(`레코드 append 실패 (${type})`, err);
    throw err;
  }
  return record;
}

export function readRecords(type: string, { limit = 0 } = {}): HubRecord[] {
  if (!(RECORD_TYPES as readonly string[]).includes(type)) {
    throw new Error(`hub/store: 알 수 없는 레코드 종류 '${type}'`);
  }
  const p = recordPath(type);
  if (!existsSync(p)) return [];

  let content: string;
  try {
    content = readFileSync(p, 'utf8').trimEnd();
  } catch {
    return [];
  }
  if (!content) return [];

  const out: HubRecord[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as HubRecord); } catch { /* 손상 줄 무시 */ }
  }
  out.reverse();
  return limit > 0 ? out.slice(0, limit) : out;
}

export function timeline({ limit = 0, types = RECORD_TYPES as readonly string[] } = {}): HubRecord[] {
  const merged: HubRecord[] = [];
  for (const type of types) {
    if (!(RECORD_TYPES as readonly string[]).includes(type)) continue;
    merged.push(...readRecords(type));
  }
  merged.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return limit > 0 ? merged.slice(0, limit) : merged;
}

export function latest(type: string): HubRecord | null {
  const rows = readRecords(type, { limit: 1 });
  return rows[0] ?? null;
}
