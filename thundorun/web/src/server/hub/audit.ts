/**
 * server/hub/audit.ts — 감사로그 해시체인 append + Supabase best-effort 미러
 * audit/append.mjs + audit/supabase-mirror.mjs 이식. blog-publisher 경로 의존 제거.
 * 저장: state/audit/audit-log.jsonl (append-only)
 * chain_hash = sha256(prev_hash|seq|action|after_hash)
 */
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { createHash, createHmac } from 'crypto';
import { paths, env } from './config';
import { makeLogger } from './logger';

const log = makeLogger('hub/audit');

function auditLogPath(): string {
  const dir = paths.audit;
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch {
    // 서버리스(Vercel) read-only FS — 디렉터리 생성 불가. 경로만 반환하고
    // append 는 비차단 처리, Supabase 미러가 1차 영속화를 담당한다.
  }
  return path.join(dir, 'audit-log.jsonl');
}

function sha256(str: string): string {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

function sign(chainHash: string): string | null {
  const key = env('AUDIT_SIGNING_KEY');
  if (!key) return null;
  return createHmac('sha256', key).update(chainHash, 'utf8').digest('hex');
}

function computeChainHash(prevHash: string, seq: number, action: string, afterHash: string): string {
  return sha256(`${prevHash}|${seq}|${action}|${afterHash}`);
}

interface LastEntry {
  seq: number;
  chain_hash: string;
}

function readLastEntry(): LastEntry {
  const p = auditLogPath();
  if (!existsSync(p)) return { seq: 0, chain_hash: 'GENESIS' };

  let content: string;
  try { content = readFileSync(p, 'utf8').trimEnd(); }
  catch { return { seq: 0, chain_hash: 'GENESIS' }; }

  if (!content) return { seq: 0, chain_hash: 'GENESIS' };
  const lines = content.split('\n').filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]) as LastEntry;
      if (typeof e.seq === 'number' && e.chain_hash) return e;
    } catch { /* 손상 줄 */ }
  }
  return { seq: 0, chain_hash: 'GENESIS' };
}

export const ACTIONS = Object.freeze({
  PUBLISH:     'publish',
  DISCARD:     'discard',
  RETRY:       'retry',
  SELF_HEAL:   'self_heal',
  ROLLBACK:    'rollback',
  KILL:        'kill',
  BUDGET_STOP: 'budget_stop',
} as const);

export type AuditAction = typeof ACTIONS[keyof typeof ACTIONS];

export interface AuditEntry {
  seq: number;
  ts: string;
  actor: string;
  action: string;
  before_hash: string | null;
  after_hash: string | null;
  reason: string;
  prev_hash: string;
  chain_hash: string;
  sig?: string;
}

export async function appendAudit(opts: {
  actor?: string;
  action: string;
  before_hash?: string | null;
  after_hash?: string | null;
  reason?: string;
}): Promise<AuditEntry> {
  const {
    actor       = 'pipeline',
    action,
    before_hash = null,
    after_hash  = null,
    reason      = '',
  } = opts;

  if (!action) throw new Error('audit: action 필수');

  const last      = readLastEntry();
  const prevHash  = last.chain_hash || 'GENESIS';
  const seq       = (last.seq || 0) + 1;
  const ts        = new Date().toISOString();
  const chainHash = computeChainHash(prevHash, seq, action, after_hash ?? '');
  const sig       = sign(chainHash);

  const entry: AuditEntry = {
    seq,
    ts,
    actor,
    action,
    before_hash:  before_hash  ?? null,
    after_hash:   after_hash   ?? null,
    reason,
    prev_hash:    prevHash,
    chain_hash:   chainHash,
    ...(sig ? { sig } : {}),
  };

  // 로컬 FS append (dev 1차 진실). 서버리스(Vercel) read-only FS 면 실패 → 비차단 처리.
  try {
    appendFileSync(auditLogPath(), JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    log.warn(`audit-log.jsonl append 실패(비차단, Supabase 미러로 대체): ${(err as Error)?.message}`);
  }

  // Supabase 미러 — 서버리스에선 이게 1차 영속화. 반환 전 await 로 적재 보장(best-effort).
  // 미러 실패해도 명령 처리는 계속(별도로 hub_commands 레코드가 추적을 보강).
  try {
    await mirrorEntry(entry);
  } catch { /* 미러 실패 무시 */ }

  return entry;
}

// ─── Supabase 미러 (best-effort) ──────────────────────────────────────────────

const AUDIT_TABLE = process.env.SUPABASE_AUDIT_TABLE ?? 'audit_log';
const ENTRY_COL   = process.env.SUPABASE_AUDIT_COLUMN ?? 'entry';

// MED-3: 서버 전용 미러 → service_role 키 사용 (anon 키 대신, 위조 방지)
function serviceCreds(): { url: string; key: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY; // 서버 전용 — 클라이언트 번들에 미노출
  return url && key ? { url, key } : null;
}

async function mirrorEntry(entry: AuditEntry): Promise<{ ok: boolean; skipped?: boolean; status?: number }> {
  const c = serviceCreds();
  if (!c) return { ok: false, skipped: true };
  let res: Response;
  try {
    res = await fetch(`${c.url}/rest/v1/${AUDIT_TABLE}`, {
      method: 'POST',
      headers: {
        apikey: c.key,
        Authorization: `Bearer ${c.key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ [ENTRY_COL]: entry }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, status: 0 };
  }
  return { ok: res.ok, status: res.status };
}
