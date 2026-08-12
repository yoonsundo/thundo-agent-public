/**
 * audit/append.mjs — AuditEntry 해시체인 append-only 로그
 * §A2/§D4 스키마 준수:
 *   seq, ts, actor, action, before_hash, after_hash, reason,
 *   prev_hash, chain_hash(sha256), sig(선택)
 * 저장: .omc/audit/audit-log.jsonl (append-only)
 * chain_hash = sha256(prev_hash + "|" + seq + "|" + action + "|" + after_hash)
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { paths, env } from '../lib/config.mjs';
import { makeLogger } from '../lib/log.mjs';
import { mirrorEntryAsync } from './supabase-mirror.mjs';

const log = makeLogger('audit/append');

// ─── 경로 ─────────────────────────────────────────────────────────────────────

function auditLogPath() {
  const dir = paths.audit;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'audit-log.jsonl');
}

// ─── 해시 유틸 ────────────────────────────────────────────────────────────────

function sha256(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

/** HMAC-SHA256 서명 (AUDIT_SIGNING_KEY 있을 때만) */
function sign(chainHash) {
  const key = env('AUDIT_SIGNING_KEY');
  if (!key) return null;
  return createHmac('sha256', key).update(chainHash, 'utf8').digest('hex');
}

/**
 * chain_hash = sha256(prev_hash + "|" + seq + "|" + action + "|" + after_hash)
 * §D4: 체인파손=위조탐지, seq갭=삭제탐지
 */
function computeChainHash(prevHash, seq, action, afterHash) {
  return sha256(`${prevHash}|${seq}|${action}|${afterHash}`);
}

// ─── 마지막 엔트리 읽기 ──────────────────────────────────────────────────────

/**
 * 마지막 AuditEntry를 동기 읽기로 반환.
 * 파일이 없거나 비어있으면 { seq: 0, chain_hash: 'GENESIS' } 반환.
 * 손상된 줄은 건너뛰고 마지막 유효 항목 사용.
 */
function readLastEntry() {
  const p = auditLogPath();
  if (!existsSync(p)) return { seq: 0, chain_hash: 'GENESIS' };

  let content;
  try {
    content = readFileSync(p, 'utf8').trimEnd();
  } catch (err) {
    log.error('audit-log.jsonl 읽기 실패 — GENESIS에서 시작', err);
    return { seq: 0, chain_hash: 'GENESIS' };
  }

  if (!content) return { seq: 0, chain_hash: 'GENESIS' };

  const lines = content.split('\n').filter(Boolean);
  if (lines.length === 0) return { seq: 0, chain_hash: 'GENESIS' };

  // 마지막 유효 항목 역방향 탐색
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (typeof entry.seq === 'number' && entry.chain_hash) return entry;
    } catch {
      // 손상된 줄 — 계속 역방향 탐색
    }
  }

  log.warn('audit-log.jsonl 유효 항목 없음 — GENESIS에서 시작');
  return { seq: 0, chain_hash: 'GENESIS' };
}

// ─── 공개 API ─────────────────────────────────────────────────────────────────

/** §D6 허용 action 열거 */
export const ACTIONS = Object.freeze({
  PUBLISH:     'publish',
  DISCARD:     'discard',
  RETRY:       'retry',
  SELF_HEAL:   'self_heal',
  ROLLBACK:    'rollback',
  KILL:        'kill',
  BUDGET_STOP: 'budget_stop',
  IMAGE:       'image',
  EVOLVE:      'evolve',
  SESSION_EXPIRED: 'session_expired',
});

/**
 * appendAudit(opts) → AuditEntry
 * opts: { actor, action, before_hash?, after_hash?, reason? }
 * append-only: 절대 기존 행 수정 불가.
 */
export function appendAudit(opts) {
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
  const chainHash = computeChainHash(prevHash, seq, action, after_hash || '');
  const sig       = sign(chainHash);

  const entry = {
    seq,
    ts,
    actor,
    action,
    before_hash:  before_hash ?? null,
    after_hash:   after_hash  ?? null,
    reason,
    prev_hash:    prevHash,
    chain_hash:   chainHash,
    ...(sig ? { sig } : {}),
  };

  const p = auditLogPath();
  try {
    appendFileSync(p, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    log.error('audit-log.jsonl append 실패', err);
    throw err;
  }

  // L4 증거 불멸: 외부 insert-only Supabase 미러에 best-effort push.
  // 로컬 append 가 1차 진실 — 미러 실패는 로컬을 막지 않는다(조용히 무시).
  mirrorEntryAsync(entry);

  return entry;
}

// CLI
if (process.argv[1] && process.argv[1].endsWith('append.mjs')) {
  const action = process.argv[2] || 'publish';
  const entry  = appendAudit({ actor: 'cli-test', action, reason: 'CLI 직접 테스트' });
  console.log('감사 항목 추가:', entry);
}
