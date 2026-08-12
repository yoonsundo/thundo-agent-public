/**
 * /api/admin/agents — 에이전트 CRUD (관리자 전용)
 *   GET    -> 목록(listAgents)
 *   POST   -> 등록/수정(upsertAgent, on conflict id)
 *   DELETE -> 삭제(?id= 또는 body.id)
 * admin role 이중 검증(미들웨어 + 핸들러). server/agents.ts 가 service_role 로 DB 접근.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession }          from 'next-auth';
import { authOptions }               from '@/lib/auth';
import { listAgents, upsertAgent, deleteAgent } from '@/server/agents';
import type { AgentRow }             from '@/server/agents';

export const dynamic = 'force-dynamic';

function unauthorized() {
  return NextResponse.json({ error: '인증 필요' }, { status: 401 });
}

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  return session && session.user?.role === 'admin';
}

export async function GET() {
  if (!(await requireAdmin())) return unauthorized();
  const agents = await listAgents();
  return NextResponse.json(agents);
}

export async function POST(req: NextRequest) {
  if (!(await requireAdmin())) return unauthorized();

  let body: Partial<AgentRow>;
  try {
    body = (await req.json()) as Partial<AgentRow>;
  } catch {
    return NextResponse.json({ error: '잘못된 JSON 바디' }, { status: 400 });
  }
  if (!body.id?.trim() || !body.name?.trim()) {
    return NextResponse.json({ error: 'id, name 필드 필수' }, { status: 400 });
  }

  const row: AgentRow = {
    id:          body.id.trim(),
    name:        body.name.trim(),
    role:        body.role ?? '',
    description: body.description ?? '',
    image_url:   body.image_url ?? null,
    emoji:       body.emoji ?? '',
    sort_order:  typeof body.sort_order === 'number' ? body.sort_order : 0,
    active:      body.active !== false,
  };

  // 공개 /agents 는 force-dynamic + no-store 라 저장 즉시 반영(별도 캐시 무효화 불필요).
  const result = await upsertAgent(row);
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}

export async function DELETE(req: NextRequest) {
  if (!(await requireAdmin())) return unauthorized();

  const url = new URL(req.url);
  let id = url.searchParams.get('id') ?? '';
  if (!id) {
    try {
      const body = (await req.json()) as { id?: string };
      id = body.id ?? '';
    } catch { /* no body */ }
  }
  if (!id) return NextResponse.json({ error: 'id 필수' }, { status: 400 });

  const result = await deleteAgent(id);
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
