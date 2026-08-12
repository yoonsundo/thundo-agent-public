/**
 * audit/supabase-mirror.mjs — 로컬 해시체인 감사로그 → Supabase insert-only 미러
 *
 * L4 "증거 불멸" 경계: anon(publishable) 키로 INSERT만 허용되는 Supabase 테이블에
 * 로컬 audit-log.jsonl 의 각 엔트리를 push 한다. 서버 RLS 가 SELECT/UPDATE/DELETE 를
 * 거부하므로, 로컬에서 에이전트가 폭주해 git·로컬로그를 다 지워도 이 미러만은 외부에
 * append-only 로 남아 사람이 진상을 확인·롤백할 수 있다.
 *
 * 설계 원칙:
 *   - best-effort: 미러 실패가 로컬 append 를 막지 않는다(로컬이 1차 진실).
 *   - 멱등 push: .omc/audit/supabase-cursor.json 에 마지막 미러 seq 저장 → 재실행 안전.
 *   - anon 키만 사용(서버롤 불필요). stdlib fetch.
 *   - 테이블/컬럼은 SUPABASE_AUDIT_TABLE(기본 audit_log) + 표준 컬럼.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { paths, env } from '../lib/config.mjs';
import { makeLogger } from '../lib/log.mjs';

const log = makeLogger('audit/supabase-mirror');

const TABLE = env('SUPABASE_AUDIT_TABLE') || 'audit_log';

// 테이블 스키마: audit_log(entry jsonb NOT NULL, ...). 감사 레코드 전체를
// 단일 jsonb 컬럼 `entry` 에 저장한다(컬럼 분리 X). 컬럼명은 SUPABASE_AUDIT_COLUMN 로 변경 가능.
const ENTRY_COLUMN = env('SUPABASE_AUDIT_COLUMN') || 'entry';

function buildRow(entry) {
  return { [ENTRY_COLUMN]: entry };
}

function creds() {
  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_ANON_KEY');
  return url && key ? { url, key } : null;
}

/**
 * AUDIT_DIR_OVERRIDE 가 걸린 격리 런(테스트·이전 검증)인가.
 * 원격 미러는 insert-only 라 한번 들어가면 되돌릴 수 없다 — 격리 런의 엔트리가 섞이면
 * 로컬은 폐기해도 원격 체인은 영구히 갈라진다. 그래서 격리 시 미러를 통째로 끊는다.
 */
function isolated() {
  return Boolean(process.env.AUDIT_DIR_OVERRIDE);
}

/**
 * mirrorEntry(entry) → { ok, status, skipped? }
 * 단일 엔트리를 Supabase audit 테이블에 INSERT. 크리덴셜 없으면 skip.
 * 절대 throw 하지 않는다(best-effort).
 */
export async function mirrorEntry(entry) {
  if (isolated()) return { ok: true, skipped: true, reason: 'audit-override' };
  const c = creds();
  if (!c) return { ok: false, skipped: true, reason: 'no-credentials' };

  try {
    const res = await fetch(`${c.url}/rest/v1/${TABLE}`, {
      method: 'POST',
      headers: {
        'apikey':        c.key,
        'Authorization': `Bearer ${c.key}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=minimal',
      },
      body: JSON.stringify(buildRow(entry)),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, status: res.status, body: body.slice(0, 200) };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/** fire-and-forget: appendAudit 가 동기 흐름을 막지 않도록. 실패해도 조용히 무시. */
export function mirrorEntryAsync(entry) {
  if (isolated()) return;
  if (!creds()) return;
  Promise.resolve()
    .then(() => mirrorEntry(entry))
    .then((r) => { if (!r.ok && !r.skipped) log.warn(`미러 실패 seq=${entry.seq} (${r.status || r.error})`); })
    .catch(() => {});
}

// ─── 커서 기반 일괄 미러 (멱등) ────────────────────────────────────────────────

function cursorPath() {
  const dir = paths.audit;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'supabase-cursor.json');
}

function readCursor() {
  try { return JSON.parse(readFileSync(cursorPath(), 'utf8')).last_seq || 0; }
  catch { return 0; }
}

function writeCursor(seq) {
  writeFileSync(cursorPath(), JSON.stringify({ last_seq: seq, updated: new Date().toISOString() }), 'utf8');
}

function readAuditEntries() {
  const p = join(paths.audit, 'audit-log.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').trimEnd().split('\n')
    .filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/**
 * mirrorPending() → { pushed, failed, from, to }
 * 커서 이후 엔트리를 순서대로 push. 실패 시 그 지점에서 멈춰 커서 보존(다음 실행 재시도).
 */
export async function mirrorPending() {
  if (isolated()) {
    log.warn('AUDIT_DIR_OVERRIDE 활성 — 격리 런이므로 원격 미러 skip');
    return { pushed: 0, failed: 0, skipped: true, reason: 'audit-override' };
  }
  const c = creds();
  if (!c) { log.warn('Supabase 크리덴셜 없음 — 미러 skip'); return { pushed: 0, failed: 0, skipped: true }; }

  const cursor  = readCursor();
  const pending = readAuditEntries().filter((e) => (e.seq || 0) > cursor);
  let pushed = 0, lastOk = cursor;

  for (const entry of pending) {
    const r = await mirrorEntry(entry);
    if (r.ok) { pushed++; lastOk = entry.seq; }
    else { log.warn(`미러 중단 seq=${entry.seq} status=${r.status || r.error} ${r.body || ''}`); break; }
  }
  if (lastOk > cursor) writeCursor(lastOk);
  return { pushed, failed: pending.length - pushed, from: cursor, to: lastOk, table: TABLE };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('supabase-mirror.mjs')) {
  mirrorPending().then((r) => {
    console.log(JSON.stringify(r));
    process.exit(r.skipped ? 2 : (r.failed > 0 ? 1 : 0));
  });
}
