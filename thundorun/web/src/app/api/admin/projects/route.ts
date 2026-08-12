/**
 * /api/admin/projects — 프로젝트 CRUD (관리자 전용)
 *   GET    → 목록(listProjects)
 *   POST   → 등록/수정(upsertProject, on conflict id)
 *   DELETE → 삭제(?id= 또는 body.id)
 * admin role 이중 검증(미들웨어 + 핸들러). server/projects.ts 가 service_role 로 DB 접근.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession }          from 'next-auth';
import { authOptions }               from '@/lib/auth';
import { listProjects, upsertProject, deleteProject, setProjectCategory } from '@/server/projects';
import type { ProjectRow }           from '@/server/projects';

function unauthorized() {
  return NextResponse.json({ error: '인증 필요' }, { status: 401 });
}

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  return session && session.user?.role === 'admin';
}

export async function GET() {
  if (!(await requireAdmin())) return unauthorized();
  const projects = await listProjects();
  return NextResponse.json(projects);
}

export async function POST(req: NextRequest) {
  if (!(await requireAdmin())) return unauthorized();

  let body: Partial<ProjectRow>;
  try {
    body = (await req.json()) as Partial<ProjectRow>;
  } catch {
    return NextResponse.json({ error: '잘못된 JSON 바디' }, { status: 400 });
  }
  if (!body.id?.trim() || !body.title?.trim()) {
    return NextResponse.json({ error: 'id, title 필드 필수' }, { status: 400 });
  }

  const row: ProjectRow = {
    id:          body.id.trim(),
    title:       body.title.trim(),
    period:      body.period ?? '',
    role:        body.role ?? undefined,
    stack:       Array.isArray(body.stack) ? body.stack : [],
    description: body.description ?? '',
    highlights:  Array.isArray(body.highlights) ? body.highlights : [],
    link:        body.link ?? null,
    sort_order:  typeof body.sort_order === 'number' ? body.sort_order : 0,
    pinned:      body.pinned === true,
    // pinned_at 은 앱이 쓰지 않는다 — DB 트리거가 고정/해제 시점에 채우고 지운다.
    pinned_at:   null,
  };

  const result = await upsertProject(row);
  if (!result.ok) return NextResponse.json(result, { status: 400 });

  // 분류(detail.category)는 upsert 와 분리된 경로다 — upsert 는 detail 을 보내지 않아 DB 값을
  // 보존하는 계약이고, 여기서 detail 을 통째로 얹으면 summary·flow·personas·tech 가 날아간다.
  // 값이 없거나 알 수 없는 값이면 조용히 건너뛴다(카테고리를 모르는 기존 호출자 호환).
  const category = (body as { category?: unknown }).category;
  if (category === 'personal' || category === 'career') {
    const catResult = await setProjectCategory(row.id, category);
    if (!catResult.ok) {
      // 본문은 이미 저장됐고 분류만 실패한 상태다. 그냥 "저장 실패"로 돌려주면
      // 사용자가 전부 안 됐다고 오인해 같은 편집을 반복한다 — 무엇이 되고 무엇이 안 됐는지 말한다.
      return NextResponse.json(
        { ok: false, error: `내용은 저장됐지만 분류 변경에 실패했습니다: ${catResult.error ?? '알 수 없는 오류'}` },
        { status: 400 },
      );
    }
  }

  return NextResponse.json(result, { status: 200 });
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

  const result = await deleteProject(id);
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
