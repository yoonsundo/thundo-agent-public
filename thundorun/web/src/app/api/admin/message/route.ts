/**
 * GET  /api/admin/message — 최근 메시지 목록 반환 (최대 80건)
 * POST /api/admin/message — 사용자 메시지 전송 → handleIncoming → bot 응답
 * admin role 이중 검증.
 *
 * POST Body:  { text: string }
 * POST 응답:  { user: MsgRecord; bot: MsgRecord }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession }          from 'next-auth';
import { authOptions }               from '@/lib/auth';
import { readRecords }               from '@/server/hub/store-supabase';
import { handleIncoming }            from '@/server/hub/handleIncoming';

function unauthorized() {
  return NextResponse.json({ error: '인증 필요' }, { status: 401 });
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') return unauthorized();

  try {
    const messages = await readRecords('message', { limit: 80 });
    return NextResponse.json(messages);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') return unauthorized();

  let body: { text?: string };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: '잘못된 JSON 바디' }, { status: 400 });
  }

  const text = body.text?.trim();
  if (!text) {
    return NextResponse.json({ error: 'text 필드 필수' }, { status: 400 });
  }

  const actor = session.user?.name ?? session.user?.email ?? 'admin';

  try {
    const result = await handleIncoming({ content: text, actor });

    // handleIncoming 이 store 에 user+bot 레코드를 저장함.
    // 클라이언트 즉시 반영을 위해 최신 2건을 조회해 반환.
    const recent = await readRecords('message', { limit: 2 });
    // recent 는 최신순 — index 0 = bot, index 1 = user
    const [bot, user] = recent;
    return NextResponse.json({ user: user ?? null, bot: bot ?? null, result });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
