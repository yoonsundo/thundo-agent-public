/**
 * scripts/hub/agent-chat-supabase.mjs — thin PostgREST client for agent_chat_* tables.
 *
 * Tables: agent_chat_jobs, agent_chat_messages.
 * Uses fetch + apikey + Authorization Bearer pattern (same as store-supabase.mjs).
 * .env is loaded automatically via the config.mjs import side-effect.
 *
 * Exports:
 *   claimPendingJob()                     -> job row | null
 *   patchMessage(id, {content?, streaming?, status?, error?, subtype?})
 *   markJobStatus(jobId, status, error?)
 *   patchOrchestrationRequest(id, fields, opts?) -> boolean  (PATCH; opts.expectStatus = CAS 가드)
 *   insertOrchestrationSubtasks(rows)      -> void  (orchestration_subtasks bulk insert)
 *   deleteOrchestrationSubtasks(requestId) -> void  (orchestration_subtasks delete-by-request; idempotent materialize)
 *   patchOrchestrationSubtask(id, fields)  -> void  (orchestration_subtasks PATCH)
 *   insertChatMessage(row)                 -> void  (agent_chat_messages insert; system chips)
 *   reapStaleJobs(staleMs?)                -> string[]  (requeue stuck running jobs)
 */

import { env } from '../lib/config.mjs';
import { makeLogger } from '../lib/log.mjs';

const log = makeLogger('hub/agent-chat-sb');

// ─── Supabase connection helpers ──────────────────────────────────────────────

function isEnabled() {
  return Boolean(
    env('SUPABASE_URL') &&
    (env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_SERVICE_ROLE'))
  );
}

function restRoot() {
  return `${env('SUPABASE_URL').replace(/\/$/, '')}/rest/v1`;
}

function sbHeaders(extra = {}) {
  const key = env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_SERVICE_ROLE');
  return {
    apikey:          key,
    Authorization:   `Bearer ${key}`,
    'Content-Type':  'application/json',
    Accept:          'application/json',
    ...extra,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Claim the oldest pending job.
 * SELECT oldest pending -> optimistic PATCH status=running+claimed_at
 * (PATCH filter includes status=eq.pending so concurrent callers cannot double-claim).
 * Returns the claimed job row, or null if none available or Supabase unreachable.
 */
export async function claimPendingJob() {
  if (!isEnabled()) {
    log.warn('Supabase disabled — claimPendingJob skipped');
    return null;
  }
  const root = restRoot();

  // SELECT oldest pending job
  let sel;
  try {
    sel = await fetch(
      `${root}/agent_chat_jobs?status=eq.pending&order=created_at.asc&limit=1`,
      { headers: sbHeaders({ Prefer: 'return=representation' }) }
    );
  } catch (err) {
    log.warn('claimPendingJob SELECT network error', err?.message);
    return null;
  }
  if (!sel.ok) {
    log.warn('claimPendingJob SELECT failed', sel.status);
    return null;
  }
  const rows = await sel.json();
  if (!rows.length) return null;
  const job = rows[0];

  // Optimistic PATCH: only update if row is still pending (guards against races)
  let patch;
  try {
    patch = await fetch(
      `${root}/agent_chat_jobs?id=eq.${encodeURIComponent(job.id)}&status=eq.pending`,
      {
        method:  'PATCH',
        headers: sbHeaders({ Prefer: 'return=representation' }),
        body:    JSON.stringify({
          status:     'running',
          claimed_at: new Date().toISOString(),
        }),
      }
    );
  } catch (err) {
    log.warn('claimPendingJob PATCH network error', err?.message);
    return null;
  }
  if (!patch.ok) {
    log.warn('claimPendingJob PATCH failed', patch.status);
    return null;
  }
  const claimed = await patch.json();
  if (!claimed.length) {
    // Another worker claimed it between SELECT and PATCH
    return null;
  }
  return claimed[0];
}

/**
 * PATCH an agent_chat_messages row (절대값 set 만; content 는 항상 전체 문자열).
 *
 * Options:
 *   content    — set content directly (러너가 assemble 한 전체 텍스트)
 *   streaming  — set streaming flag (boolean)
 *   status     — set status string
 *   error      — set error string
 *   subtype    — set message subtype ('ai_plan' | 'hold_reason' | 'exec' | ...)
 */
export async function patchMessage(messageId, {
  content,
  streaming,
  status,
  error,
  subtype,
} = {}) {
  if (!isEnabled()) return;
  const root = restRoot();

  const body = { updated_at: new Date().toISOString() };
  if (streaming !== undefined) body.streaming = streaming;
  if (status    !== undefined) body.status    = status;
  if (error     !== undefined) body.error     = error;
  if (content   !== undefined) body.content   = content;
  if (subtype   !== undefined) body.subtype   = subtype;

  try {
    const res = await fetch(
      `${root}/agent_chat_messages?id=eq.${encodeURIComponent(messageId)}`,
      {
        method:  'PATCH',
        headers: sbHeaders({ Prefer: 'return=minimal' }),
        body:    JSON.stringify(body),
      }
    );
    if (!res.ok) {
      log.warn('patchMessage PATCH failed', res.status);
    }
  } catch (err) {
    log.warn('patchMessage PATCH network error', err?.message);
  }
}

/**
 * Update job status (and optional error) in Supabase.
 * Sets finished_at when status is 'done' or 'error'.
 */
export async function markJobStatus(jobId, status, error = null) {
  if (!isEnabled()) return;
  const root = restRoot();

  const body = { status };
  if (error !== null) body.error = error;
  if (status === 'done' || status === 'error') {
    body.finished_at = new Date().toISOString();
  }

  try {
    const res = await fetch(
      `${root}/agent_chat_jobs?id=eq.${encodeURIComponent(jobId)}`,
      {
        method:  'PATCH',
        headers: sbHeaders({ Prefer: 'return=minimal' }),
        body:    JSON.stringify(body),
      }
    );
    if (!res.ok) {
      log.warn('markJobStatus PATCH failed', res.status);
    }
  } catch (err) {
    log.warn('markJobStatus PATCH network error', err?.message);
  }
}

// ─── Orchestration board helpers ────────────────────────────────────────────────

/**
 * PATCH an orchestration_requests row (absolute field set + touch updated_at).
 * Used by the runner decompose step to write plan/title/status.
 *
 * opts.expectStatus (선택): 지정하면 `status=eq.<expectStatus>` 조건을 걸어 **compare-and-swap**
 * 로 동작한다 — 조건 불일치(그 사이 관리자가 상태를 바꿈)면 0행이 갱신되고 false 를 반환한다.
 * 웹측 transition 들이 `.in('status',[...]).select()` 로 경합을 잡는 것과 동일한 방어를 데몬에
 * 부여해, 마지막 서브태스크 done 직후 잠금이 풀린 틈의 관리자 전환을 데몬이 덮어쓰지 않게 한다.
 * @returns {Promise<boolean>} 실제로 1행 이상 갱신됐으면 true(무-가드는 성공 시 항상 true).
 */
export async function patchOrchestrationRequest(id, fields = {}, opts = {}) {
  if (!isEnabled()) return true;
  if (!id) { log.warn('patchOrchestrationRequest skipped — no id'); return false; }
  const root  = restRoot();
  const body  = { ...fields, updated_at: new Date().toISOString() };
  const guard = opts.expectStatus ? `&status=eq.${encodeURIComponent(opts.expectStatus)}` : '';
  const prefer = opts.expectStatus ? 'return=representation' : 'return=minimal';
  try {
    const res = await fetch(
      `${root}/orchestration_requests?id=eq.${encodeURIComponent(id)}${guard}`,
      {
        method:  'PATCH',
        headers: sbHeaders({ Prefer: prefer }),
        body:    JSON.stringify(body),
      }
    );
    if (!res.ok) { log.warn('patchOrchestrationRequest PATCH failed', res.status); return false; }
    if (opts.expectStatus) {
      const rows = await res.json().catch(() => []);
      return Array.isArray(rows) && rows.length > 0;   // false = CAS 실패(그 사이 상태가 바뀜)
    }
    return true;
  } catch (err) {
    log.warn('patchOrchestrationRequest PATCH network error', err?.message);
    return false;
  }
}

/**
 * Bulk-insert orchestration_subtasks rows (created_at/updated_at stamped here).
 * id is server-defaulted ('sub_' pk). No-op on empty rows.
 */
export async function insertOrchestrationSubtasks(rows = []) {
  if (!isEnabled()) return;
  if (!Array.isArray(rows) || rows.length === 0) return;
  const root = restRoot();
  const stamp = new Date().toISOString();
  const body = rows.map(r => ({ ...r, created_at: stamp, updated_at: stamp }));
  try {
    const res = await fetch(
      `${root}/orchestration_subtasks`,
      {
        method:  'POST',
        headers: sbHeaders({ Prefer: 'return=minimal' }),
        body:    JSON.stringify(body),
      }
    );
    if (!res.ok) log.warn('insertOrchestrationSubtasks POST failed', res.status);
  } catch (err) {
    log.warn('insertOrchestrationSubtasks POST network error', err?.message);
  }
}

/**
 * Delete all orchestration_subtasks rows for a request_id.
 * Makes materialize idempotent: a reap re-run or replan re-decompose must not
 * accumulate duplicate subtask rows — the runner deletes then re-inserts.
 * Best-effort; never throws (daemon must not die on a cleanup failure).
 */
export async function deleteOrchestrationSubtasks(requestId) {
  if (!isEnabled()) return;
  if (!requestId) { log.warn('deleteOrchestrationSubtasks skipped — no request_id'); return; }
  const root = restRoot();
  try {
    const res = await fetch(
      `${root}/orchestration_subtasks?request_id=eq.${encodeURIComponent(requestId)}`,
      {
        method:  'DELETE',
        headers: sbHeaders({ Prefer: 'return=minimal' }),
      }
    );
    if (!res.ok) log.warn('deleteOrchestrationSubtasks DELETE failed', res.status);
  } catch (err) {
    log.warn('deleteOrchestrationSubtasks DELETE network error', err?.message);
  }
}

/**
 * PATCH an orchestration_subtasks row (absolute field set + touch updated_at).
 * Used by the runner execute finalize to write exec_status/result_excerpt.
 */
export async function patchOrchestrationSubtask(id, fields = {}) {
  if (!isEnabled()) return;
  if (!id) { log.warn('patchOrchestrationSubtask skipped — no id'); return; }
  const root = restRoot();
  const body = { ...fields, updated_at: new Date().toISOString() };
  try {
    const res = await fetch(
      `${root}/orchestration_subtasks?id=eq.${encodeURIComponent(id)}`,
      {
        method:  'PATCH',
        headers: sbHeaders({ Prefer: 'return=minimal' }),
        body:    JSON.stringify(body),
      }
    );
    if (!res.ok) log.warn('patchOrchestrationSubtask PATCH failed', res.status);
  } catch (err) {
    log.warn('patchOrchestrationSubtask PATCH network error', err?.message);
  }
}

/**
 * Fetch a single orchestration_requests row by id (or null).
 * Runner-side: execute jobs need the request's worktree/status/plan to decide
 * whether to run in an isolated dev worktree and to build the done_result.
 */
export async function getOrchestrationRequest(id) {
  if (!isEnabled() || !id) return null;
  const root = restRoot();
  try {
    const res = await fetch(
      `${root}/orchestration_requests?id=eq.${encodeURIComponent(id)}&limit=1`,
      { headers: sbHeaders() }
    );
    if (!res.ok) { log.warn('getOrchestrationRequest GET failed', res.status); return null; }
    const rows = await res.json();
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch (err) {
    log.warn('getOrchestrationRequest GET network error', err?.message);
    return null;
  }
}

/**
 * Fetch all orchestration_subtasks rows for a request, ordered by ordinal.
 * Runner-side: used to detect "all subtasks done" (auto-deploy trigger) and to
 * summarize results into the done_result message. Returns [] on error.
 */
export async function getOrchestrationSubtasks(requestId) {
  if (!isEnabled() || !requestId) return [];
  const root = restRoot();
  try {
    const res = await fetch(
      `${root}/orchestration_subtasks?request_id=eq.${encodeURIComponent(requestId)}&order=ordinal.asc`,
      { headers: sbHeaders() }
    );
    if (!res.ok) { log.warn('getOrchestrationSubtasks GET failed', res.status); return []; }
    const rows = await res.json();
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    log.warn('getOrchestrationSubtasks GET network error', err?.message);
    return [];
  }
}

/**
 * Insert a single agent_chat_messages row (created_at/updated_at stamped here).
 * Used by the runner to append system chips into a thread (e.g. a 'status_change'
 * callout), mirroring the web's message insert. Requires id + session_id.
 * Best-effort; never throws.
 */
export async function insertChatMessage(row = {}) {
  if (!isEnabled()) return;
  if (!row || !row.id || !row.session_id) {
    log.warn('insertChatMessage skipped — missing id/session_id');
    return;
  }
  const root = restRoot();
  const stamp = new Date().toISOString();
  const body = { created_at: stamp, updated_at: stamp, ...row };
  try {
    const res = await fetch(
      `${root}/agent_chat_messages`,
      {
        method:  'POST',
        headers: sbHeaders({ Prefer: 'return=minimal' }),
        body:    JSON.stringify(body),
      }
    );
    if (!res.ok) log.warn('insertChatMessage POST failed', res.status);
  } catch (err) {
    log.warn('insertChatMessage POST network error', err?.message);
  }
}

/**
 * Requeue stale running jobs (crashed/killed runner recovery — AC 9 resume).
 *
 * Finds agent_chat_jobs status='running' with claimed_at older than staleMs,
 * resets them to status='pending', claimed_at=null (conditional on still-running
 * so a live job is never yanked). For linked orchestration subtasks, resets
 * exec_status running→queued. Resets the streaming message content to '' so the
 * re-stream shows a fresh run instead of concatenating onto the dead partial.
 *
 * Returns the list of reaped job ids (best-effort; daemon never dies on error).
 */
export async function reapStaleJobs(staleMs = 10 * 60 * 1000) {
  if (!isEnabled()) return [];
  const root   = restRoot();
  const cutoff = new Date(Date.now() - staleMs).toISOString();

  let sel;
  try {
    sel = await fetch(
      `${root}/agent_chat_jobs?status=eq.running&claimed_at=lt.${encodeURIComponent(cutoff)}&order=claimed_at.asc`,
      { headers: sbHeaders() }
    );
  } catch (err) {
    log.warn('reapStaleJobs SELECT network error', err?.message);
    return [];
  }
  if (!sel.ok) {
    log.warn('reapStaleJobs SELECT failed', sel.status);
    return [];
  }
  const stale = await sel.json();
  if (!Array.isArray(stale) || stale.length === 0) return [];

  const reaped = [];
  for (const job of stale) {
    // Reset job to pending — conditional on still-running (avoid double-reap race).
    try {
      const res = await fetch(
        `${root}/agent_chat_jobs?id=eq.${encodeURIComponent(job.id)}&status=eq.running`,
        {
          method:  'PATCH',
          headers: sbHeaders({ Prefer: 'return=representation' }),
          body:    JSON.stringify({ status: 'pending', claimed_at: null }),
        }
      );
      if (!res.ok) { log.warn('reapStaleJobs job PATCH failed', res.status); continue; }
      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length === 0) continue; // lost the race
    } catch (err) {
      log.warn('reapStaleJobs job PATCH network error', err?.message);
      continue;
    }

    // Reset linked subtask running→queued.
    if (job.subtask_id) {
      try {
        await fetch(
          `${root}/orchestration_subtasks?id=eq.${encodeURIComponent(job.subtask_id)}&exec_status=eq.running`,
          {
            method:  'PATCH',
            headers: sbHeaders({ Prefer: 'return=minimal' }),
            body:    JSON.stringify({ exec_status: 'queued', updated_at: new Date().toISOString() }),
          }
        );
      } catch (err) {
        log.warn('reapStaleJobs subtask PATCH network error', err?.message);
      }
    }

    // Reset streaming message content so re-stream doesn't concatenate.
    if (job.message_id) {
      try {
        await fetch(
          `${root}/agent_chat_messages?id=eq.${encodeURIComponent(job.message_id)}`,
          {
            method:  'PATCH',
            headers: sbHeaders({ Prefer: 'return=minimal' }),
            body:    JSON.stringify({ content: '', streaming: true, status: 'ok', updated_at: new Date().toISOString() }),
          }
        );
      } catch (err) {
        log.warn('reapStaleJobs message PATCH network error', err?.message);
      }
    }

    reaped.push(job.id);
  }

  if (reaped.length) log.info(`reaped ${reaped.length} stale job(s): ${reaped.join(',')}`);
  return reaped;
}
