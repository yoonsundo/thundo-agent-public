/**
 * scripts/hub/chat-store.mjs — 러너(WSL) 로컬 sqlite 진실원본 (node:sqlite, 무의존성).
 *
 * 대화 이력의 durable source of truth. 러너가 잡을 처리하며 여기에 쓰고,
 * 동시에 Supabase(웹 트랜스포트)에도 미러링한다(agent-runner.mjs).
 *
 * 스키마는 supabase/agent_chat.sql 과 동형(3테이블). 웹이 못 읽는 sqlite 는
 * 러너 로컬에만 있고, 전체 이력 열람은 러너 경유(향후 엔드포인트)로 제공.
 *
 * DB 경로: env CHAT_SQLITE_PATH 또는 기본 state/hub/agent-chat.sqlite
 */
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..', '..'); // blog-publisher/

function dbPath() {
  return process.env.CHAT_SQLITE_PATH || join(ROOT, 'state', 'hub', 'agent-chat.sqlite');
}

let _db = null;
export function getDb() {
  if (_db) return _db;
  const p = dbPath();
  mkdirSync(dirname(p), { recursive: true });
  _db = new DatabaseSync(p);
  _db.exec(`
    create table if not exists agent_chat_sessions (
      id text primary key, title text not null default '새 대화',
      created_by text not null default '', created_at text not null, updated_at text not null
    );
    create table if not exists agent_chat_messages (
      id text primary key, session_id text not null, role text not null,
      agent_id text, content text not null default '', streaming integer not null default 0,
      status text not null default 'ok', error text, created_at text not null, updated_at text not null
    );
    create index if not exists acm_session_idx on agent_chat_messages(session_id, created_at);
    create table if not exists agent_chat_jobs (
      id text primary key, session_id text not null, message_id text not null,
      agent_id text, prompt text not null, status text not null default 'pending',
      error text, created_at text not null, claimed_at text, finished_at text
    );
    create index if not exists acj_pending_idx on agent_chat_jobs(status, created_at);
  `);
  return _db;
}

const now = () => new Date().toISOString();

/** 잡을 로컬에 기록(러너가 Supabase 에서 받은 잡을 미러). */
export function upsertJob(job) {
  const db = getDb();
  db.prepare(`insert into agent_chat_jobs (id, session_id, message_id, agent_id, prompt, status, created_at)
    values (?,?,?,?,?,?,?) on conflict(id) do update set status=excluded.status`)
    .run(job.id, job.session_id, job.message_id, job.agent_id ?? null, job.prompt, job.status ?? 'pending', now());
}

export function markJob(id, status, error = null) {
  const db = getDb();
  const col = status === 'running' ? 'claimed_at' : status === 'done' || status === 'error' ? 'finished_at' : null;
  if (col) db.prepare(`update agent_chat_jobs set status=?, error=?, ${col}=? where id=?`).run(status, error, now(), id);
  else db.prepare(`update agent_chat_jobs set status=?, error=? where id=?`).run(status, error, id);
}

/** assistant placeholder 를 로컬에 보장(없으면 생성). */
export function ensureMessage(m) {
  const db = getDb();
  db.prepare(`insert into agent_chat_messages (id, session_id, role, agent_id, content, streaming, status, created_at, updated_at)
    values (?,?,?,?,?,?,?,?,?) on conflict(id) do nothing`)
    .run(m.id, m.session_id, m.role, m.agent_id ?? null, m.content ?? '', m.streaming ? 1 : 0, m.status ?? 'ok', now(), now());
}

/** 스트리밍 델타 누적(로컬 content 에 append). */
export function appendDelta(messageId, delta) {
  const db = getDb();
  db.prepare(`update agent_chat_messages set content = content || ?, streaming=1, updated_at=? where id=?`)
    .run(delta, now(), messageId);
}

export function finishMessage(messageId, { status = 'ok', error = null } = {}) {
  const db = getDb();
  db.prepare(`update agent_chat_messages set streaming=0, status=?, error=?, updated_at=? where id=?`)
    .run(status, error, now(), messageId);
}

export function getMessage(messageId) {
  return getDb().prepare(`select * from agent_chat_messages where id=?`).get(messageId) ?? null;
}

export function listMessages(sessionId, limit = 200) {
  return getDb().prepare(`select * from agent_chat_messages where session_id=? order by created_at asc limit ?`)
    .all(sessionId, limit);
}
