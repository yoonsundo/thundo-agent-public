/**
 * server/agentChat.ts — 관리자 웹 에이전트 채팅 서버 유틸 (서버 전용).
 *
 * 웹(Vercel)이 읽는 트랜스포트. getSupabase(service_role) 경유.
 * 러너(WSL)가 sqlite 진실원본에 쓰면서 여기(Supabase)에도 미러링하고,
 * 웹은 여기서 세션·메시지를 읽고 SSE 로 tail 한다.
 *
 * id 생성은 서버에서: sess_/msg_/job_ 접두 + 시간+랜덤.
 */
import { getSupabase } from '@/lib/supabase';

export type Role = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  session_id: string;
  role: Role;
  agent_id: string | null;
  subtype: string | null;
  content: string;
  streaming: boolean;
  status: 'ok' | 'error';
  error: string | null;
  tool_state: { tool: string; status: string }[];
  created_at: string;
}

export interface ChatSession {
  id: string;
  title: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

let _counter = 0;
export function mkId(prefix: 'sess' | 'msg' | 'job'): string {
  _counter = (_counter + 1) % 1_000;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${_counter.toString(36)}${rand}`;
}

function normalizeMessage(r: Record<string, unknown>): ChatMessage {
  return {
    id: String(r.id ?? ''),
    session_id: String(r.session_id ?? ''),
    role: (r.role as Role) ?? 'assistant',
    agent_id: r.agent_id ? String(r.agent_id) : null,
    subtype: r.subtype ? String(r.subtype) : null,
    content: String(r.content ?? ''),
    streaming: r.streaming === true,
    status: r.status === 'error' ? 'error' : 'ok',
    error: r.error ? String(r.error) : null,
    tool_state: Array.isArray(r.tool_state) ? (r.tool_state as ChatMessage['tool_state']) : [],
    created_at: String(r.created_at ?? ''),
  };
}

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/** 세션 생성. 없으면 기본 제목. */
export async function createSession(createdBy: string, title = '새 대화'): Promise<Result<ChatSession>> {
  const db = getSupabase();
  if (!db) return { ok: false, error: 'Supabase 미연결' };
  const id = mkId('sess');
  const { data, error } = await db
    .from('agent_chat_sessions')
    .insert({ id, title, created_by: createdBy })
    .select('*')
    .maybeSingle();
  if (error || !data) return { ok: false, error: error?.message ?? '세션 생성 실패' };
  return { ok: true, data: data as ChatSession };
}

export async function listSessions(limit = 50): Promise<ChatSession[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from('agent_chat_sessions')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error || !Array.isArray(data)) return [];
  return data as ChatSession[];
}

export async function ensureSession(sessionId: string | undefined, createdBy: string): Promise<string> {
  if (sessionId) return sessionId;
  const res = await createSession(createdBy);
  return res.ok ? res.data.id : mkId('sess');
}

export async function listMessages(sessionId: string, limit = 200): Promise<ChatMessage[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from('agent_chat_messages')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error || !Array.isArray(data)) return [];
  return data.map(normalizeMessage);
}

/** SSE tail: updated_at 이 since 이후인 메시지(스트리밍 델타 포함). */
export async function messagesSince(sessionId: string, sinceIso: string): Promise<ChatMessage[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from('agent_chat_messages')
    .select('*')
    .eq('session_id', sessionId)
    .gt('updated_at', sinceIso)
    .order('created_at', { ascending: true });
  if (error || !Array.isArray(data)) return [];
  return data.map(normalizeMessage);
}

export async function insertUserMessage(sessionId: string, text: string): Promise<string> {
  const db = getSupabase();
  const id = mkId('msg');
  if (!db) return id;
  await db.from('agent_chat_messages').insert({
    id, session_id: sessionId, role: 'user', content: text, streaming: false,
  });
  return id;
}

export async function insertAssistantPlaceholder(sessionId: string, agentId: string | null): Promise<string> {
  const db = getSupabase();
  const id = mkId('msg');
  if (!db) return id;
  await db.from('agent_chat_messages').insert({
    id, session_id: sessionId, role: 'assistant', agent_id: agentId, content: '', streaming: true,
  });
  return id;
}

export async function enqueueJob(args: {
  sessionId: string; messageId: string; agentId: string | null; prompt: string;
}): Promise<string> {
  const db = getSupabase();
  const id = mkId('job');
  if (!db) return id;
  await db.from('agent_chat_jobs').insert({
    id, session_id: args.sessionId, message_id: args.messageId,
    agent_id: args.agentId, prompt: args.prompt, status: 'pending',
  });
  return id;
}

/** 세션 updated_at 갱신 (사이드바 정렬용). */
export async function touchSession(sessionId: string): Promise<void> {
  const db = getSupabase();
  if (!db) return;
  await db.from('agent_chat_sessions').update({ updated_at: new Date().toISOString() }).eq('id', sessionId);
}
