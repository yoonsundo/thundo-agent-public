/**
 * POST /api/admin/query — CEO Q&A 질의
 * 환각 금지: LLM 없음. 결정론 intent + store 데이터 조회만.
 * 데이터 없으면 "정보 없음" 명시.
 *
 * Body: { question: string }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession }          from 'next-auth';
import { authOptions }               from '@/lib/auth';
import { answerQuery }               from '@/server/hub/query';

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') {
    return NextResponse.json({ error: '인증 필요' }, { status: 401 });
  }

  let body: { question?: string };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: '잘못된 JSON 바디' }, { status: 400 });
  }

  const question = body.question?.trim();
  if (!question) {
    return NextResponse.json({ error: 'question 필드 필수' }, { status: 400 });
  }

  try {
    const result = await answerQuery(question);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
