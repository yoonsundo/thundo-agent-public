/**
 * GET  /api/admin/agent-chat          — list sessions
 * GET  /api/admin/agent-chat?session_id=X — list messages in session
 * POST /api/admin/agent-chat          — send message, enqueue agent job
 * admin role required.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession }          from 'next-auth';
import { authOptions }               from '@/lib/auth';
import {
  ensureSession,
  listSessions,
  listMessages,
  insertUserMessage,
  insertAssistantPlaceholder,
  enqueueJob,
  touchSession,
} from '@/server/agentChat';
import { listAgents } from '@/server/agents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function unauthorized() {
  return NextResponse.json({ error: '인증 필요' }, { status: 401 });
}

const AGENT_LIST_RE =
  /사용\s*가능(한)?\s*에이전트|어떤\s*에이전트|에이전트\s*목록|무슨\s*에이전트|사용가능한 에이전트/;

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') return unauthorized();

  const sessionId = req.nextUrl.searchParams.get('session_id');

  if (sessionId) {
    const messages = await listMessages(sessionId);
    return NextResponse.json({ messages });
  }

  const sessions = await listSessions();
  return NextResponse.json({ sessions });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') return unauthorized();

  let body: { session_id?: string; text?: string; agent_id?: string };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: '잘못된 JSON 바디' }, { status: 400 });
  }

  const text = body.text?.trim();
  if (!text) {
    return NextResponse.json({ error: 'text 필드 필수' }, { status: 400 });
  }

  // 에이전트 목록 요청 — enqueue 없이 즉시 반환
  if (AGENT_LIST_RE.test(text)) {
    const agents = await listAgents();
    return NextResponse.json({
      type: 'agent_list',
      agents: agents.map(a => ({ id: a.id, name: a.name, role: a.role })),
    });
  }

  const createdBy = session.user?.email ?? session.user?.name ?? 'admin';
  const sessionId = await ensureSession(body.session_id, createdBy);

  // @agent 라우팅: body.agent_id 우선, 없으면 "@id " 접두 파싱
  const atMatch = text.match(/^@([a-z0-9_-]+)/i);
  let agentId: string | null = body.agent_id ?? atMatch?.[1]?.toLowerCase() ?? null;
  const strippedText = atMatch ? text.replace(/^@[a-z0-9_-]+\s*/i, '') : text;

  // agentId 유효성 검증 — 존재하지 않으면 null 로 폴백
  if (agentId) {
    const agents = await listAgents();
    if (!agents.some(a => a.id === agentId)) agentId = null;
  }

  const uid = await insertUserMessage(sessionId, text);
  const mid = await insertAssistantPlaceholder(sessionId, agentId);
  const jid = await enqueueJob({ sessionId, messageId: mid, agentId, prompt: strippedText });
  await touchSession(sessionId);

  return NextResponse.json({
    ok: true,
    session_id: sessionId,
    job_id: jid,
    assistant_message_id: mid,
    user_message_id: uid,
    agent_id: agentId,
  });
}
