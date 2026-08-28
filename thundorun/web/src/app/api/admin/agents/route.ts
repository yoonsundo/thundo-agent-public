/**
 * /api/admin/agents — 에이전트 CRUD (관리자 전용)
 *   GET    -> 목록(listAgents)
 *   POST   -> 등록/수정(upsertAgent, on conflict id)
 *   DELETE -> 삭제(?id= 또는 body.id)
 * admin role 이중 검증(미들웨어 + 핸들러). server/agents.ts 가 service_role 로 DB 접근.
 */
import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath }          from 'next/cache';
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

  /**
   * 공개 `/agents` 는 force-dynamic + no-store 라 저장 즉시 반영된다.
   * ⚠ 그런데 **홈(`/`)도 같은 목록을 그리고, 홈만 ISR(300초)이다.** 그 페이지 하나만 보고
   *    "무효화 불필요"로 판단했던 것이 이 주석의 원래 내용이었다 — 소비자가 둘이면 둘 다 봐야 한다.
   */
  const result = await upsertAgent(row);
  if (result.ok) revalidatePath('/');
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
  if (result.ok) revalidatePath('/');
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
