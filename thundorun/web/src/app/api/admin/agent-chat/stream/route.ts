/**
 * GET /api/admin/agent-chat/stream — SSE delta stream for a chat session.
 *
 * Query: ?session_id=X (required), ?since=<ISO> (optional, default: now-2s)
 * Reconnection: Last-Event-ID header is used as since if present.
 *
 * Events emitted:
 *   event: ping   data: { ts, session_id }
 *   event: delta  data: { message_id, content, streaming, status, agent_id, role, error, tool_state }
 *   event: done   data: { message_id, status, error }   (when streaming flips to false)
 *   event: error  data: { message }
 *   : keepalive                                          (comment every ~15s)
 *
 * Closes after 55s so the client reconnects (Vercel 60s limit).
 */
import { NextRequest }      from 'next/server';
import { getServerSession } from 'next-auth';
import { getToken }         from 'next-auth/jwt';
import { authOptions }      from '@/lib/auth';
import { messagesSince }    from '@/server/agentChat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POLL_INTERVAL_MS     = 1_000;
const MAX_DURATION_MS      = 55_000;
const KEEPALIVE_INTERVAL_MS = 15_000;

export async function GET(req: NextRequest) {
  // admin double-gate: session first, JWT token fallback (mirrors stream/route.ts)
  const session = await getServerSession(authOptions).catch(() => null);
  const token   = session
    ? null
    : await getToken({ req, secret: process.env.NEXTAUTH_SECRET }).catch(() => null);

  const isAdmin =
    session?.user?.role === 'admin' ||
    token?.role === 'admin';

  if (!isAdmin) {
    return new Response(JSON.stringify({ error: '인증 필요' }), {
      status:  401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const params    = req.nextUrl.searchParams;
  const sessionId = params.get('session_id');

  if (!sessionId) {
    return new Response(JSON.stringify({ error: 'session_id 필수' }), {
      status:  400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Last-Event-ID (SSE reconnection header) > ?since param > default now-2s
  const lastEventId  = req.headers.get('last-event-id');
  const sinceParam   = params.get('since');
  const defaultSince = new Date(Date.now() - 2_000).toISOString();
  let lastSeen       = lastEventId ?? sinceParam ?? defaultSince;

  const startTime      = Date.now();
  let lastKeepalive    = Date.now();
  // track per-message streaming state to detect the false-flip
  const streamingWas   = new Map<string, boolean>();

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();

      function send(raw: string) {
        try { controller.enqueue(enc.encode(raw)); } catch { /* connection closed */ }
      }

      function sendEvent(eventName: string, data: unknown) {
        send(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
      }

      // initial ping
      sendEvent('ping', { ts: new Date().toISOString(), session_id: sessionId });

      while (Date.now() - startTime < MAX_DURATION_MS) {
        if (req.signal.aborted) break;

        // wait POLL_INTERVAL_MS or abort
        await new Promise<void>(resolve => {
          const t = setTimeout(resolve, POLL_INTERVAL_MS);
          req.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
        });

        if (req.signal.aborted) break;

        // keepalive comment every ~15s
        if (Date.now() - lastKeepalive >= KEEPALIVE_INTERVAL_MS) {
          send(': keepalive\n\n');
          lastKeepalive = Date.now();
        }

        try {
          // capture cursor BEFORE the query so updates during I/O are not missed
          const cursor = new Date().toISOString();
          const msgs   = await messagesSince(sessionId, lastSeen);

          for (const msg of msgs) {
            sendEvent('delta', {
              message_id: msg.id,
              content:    msg.content,
              streaming:  msg.streaming,
              status:     msg.status,
              agent_id:   msg.agent_id,
              role:       msg.role,
              error:      msg.error,
              tool_state: msg.tool_state,
            });

            // emit done when streaming flips to false
            const prev = streamingWas.get(msg.id);
            if (prev !== false && msg.streaming === false) {
              sendEvent('done', {
                message_id: msg.id,
                status:     msg.status,
                error:      msg.error,
              });
            }
            streamingWas.set(msg.id, msg.streaming);
          }

          lastSeen = cursor;
        } catch (err) {
          sendEvent('error', { message: (err as Error).message });
        }
      }

      // 55s lifetime reached — close so client reconnects
      try { controller.close(); } catch { /* already closed */ }
    },
    cancel() { /* client closed the connection */ },
  });

  return new Response(stream, {
    headers: {
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache, no-store',
      Connection:          'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
