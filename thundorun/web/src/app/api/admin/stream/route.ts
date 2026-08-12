/**
 * GET /api/admin/stream — SSE(Server-Sent Events) 실시간 스트림
 *
 * 이벤트 형식: event: record\ndata: <JSON>\n\n
 * 인증: admin role (쿠키 세션). getToken fallback.
 *
 * 구현: Vercel 서버리스에서 상시 worker 불가 → 30초마다 최신 레코드 폴링 push.
 * 실제 real-time 은 클라이언트 폴백 폴링(10s)으로 보완.
 */
import { NextRequest }      from 'next/server';
import { getServerSession } from 'next-auth';
import { getToken }         from 'next-auth/jwt';
import { authOptions }      from '@/lib/auth';
import { timeline }         from '@/server/hub/store-supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POLL_INTERVAL_MS = 30_000;
const MAX_DURATION_MS  = 55_000; // Vercel 함수 최대 실행 시간 (60s) - 여유 5s

export async function GET(req: NextRequest) {
  // 인증 이중 검증 — SSE는 쿠키 헤더 환경에서 세션 우선, JWT 폴백
  const session = await getServerSession(authOptions).catch(() => null);
  const token   = session ? null : await getToken({ req, secret: process.env.NEXTAUTH_SECRET }).catch(() => null);

  const isAdmin =
    (session?.user?.role === 'admin') ||
    (token?.role === 'admin');

  if (!isAdmin) {
    return new Response('인증 필요', { status: 401 });
  }

  let lastTs = new Date(Date.now() - 60_000).toISOString(); // 최근 60초 기준 시작
  const startTime = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();

      function send(eventName: string, data: unknown) {
        try {
          controller.enqueue(
            enc.encode(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch { /* 연결 종료 */ }
      }

      // 연결 확인 ping
      send('ping', { ts: new Date().toISOString() });

      // 폴링 루프 — Vercel timeout 내
      while (Date.now() - startTime < MAX_DURATION_MS) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

        try {
          const records = await timeline({ limit: 20 });
          const newRecs = records.filter(r => (r.ts ?? '') > lastTs);
          if (newRecs.length > 0) {
            for (const rec of newRecs.slice().reverse()) {
              send('record', rec);
            }
            lastTs = newRecs[0].ts ?? lastTs;
          }
        } catch { /* DB 오류 무시 — 다음 루프에서 재시도 */ }
      }

      // 함수 수명 초과 — 재연결 유도
      try { controller.close(); } catch { /* 이미 종료 */ }
    },
    cancel() { /* 클라이언트가 연결을 닫음 */ },
  });

  return new Response(stream, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      Connection:      'keep-alive',
      'X-Accel-Buffering': 'no', // nginx 버퍼링 비활성화
    },
  });
}
