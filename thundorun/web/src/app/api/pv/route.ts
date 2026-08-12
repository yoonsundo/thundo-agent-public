/**
 * POST /api/pv — UV(순방문자) 클라이언트 비콘 수집(공개). Node 런타임.
 * 역할: UV(source='client')만 적재. PV(조회수)는 미들웨어가 전담 → 이 경로로 PV 조작 불가.
 * 방어: same-origin Origin 체크 · payload 크기캡 · 봇 UA 필터 · per-IP 캡(DB) · 전역 하드캡(DB).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { isBot, clientIp, hmacVisitor, pgRpc, refHost, dateParts } from '@/lib/traffic';

export const runtime = 'nodejs';

const MAX_BODY = 1024; // 비콘 payload 1KB 초과는 거부

function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  const host = req.headers.get('host');
  if (!origin || !host) return false;            // 비콘은 Origin 포함 — 없으면 거부
  try {
    return new URL(origin).host === host;        // cross-origin 거부
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  // 1) same-origin
  if (!sameOrigin(req)) {
    return NextResponse.json({ ok: false, reason: 'origin' }, { status: 403 });
  }
  // 2) 봇 UA 차단(조용히 no-op — 필터링 노출 안 함)
  const ua = req.headers.get('user-agent');
  if (isBot(ua)) {
    return NextResponse.json({ ok: false, reason: 'bot' }, { status: 200 });
  }
  // 3) payload 크기캡
  const raw = await req.text();
  if (raw.length > MAX_BODY) {
    return NextResponse.json({ ok: false, reason: 'too_large' }, { status: 413 });
  }
  let body: { cid?: string; path?: string; ref?: string };
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    return NextResponse.json({ ok: false, reason: 'bad_json' }, { status: 400 });
  }
  const cid = String(body.cid || '').slice(0, 100);
  const path = String(body.path || '').slice(0, 300);
  if (!cid || !path) {
    return NextResponse.json({ ok: false, reason: 'missing' }, { status: 400 });
  }
  // 4) per-IP 캡: visitor_id = HMAC(ip+date) 버킷 + cid (원본 IP 비가역).
  //    UA 를 버킷 키에서 제외 — 동일 IP가 UA 회전으로 캡을 우회하지 못하게(진짜 IP당 제한).
  const { date } = dateParts(new Date());
  const ip = clientIp(req.headers);
  const visitorHash = await hmacVisitor(ip, 'pv-cap', date);
  // 가명화 키가 없으면 집계하지 않는다(§ traffic.ts hashSecret 주석).
  if (!visitorHash) return NextResponse.json({ ok: true, skipped: 'no-hash-secret' });
  const ipBucket = visitorHash.slice(0, 16);
  const host = req.headers.get('host');
  const ref = refHost(body.ref, host);

  // 관리자(role=admin) 본인 테스트 방문 태깅 — 집계는 하되 실제 트래픽과 분리(nodejs 런타임).
  // getToken throw(손상된 세션 쿠키 등) 방어 — 실패해도 UV 집계 자체는 그대로 진행(isAdmin=false 폴백).
  let isAdmin = false;
  try {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
    isAdmin = token?.role === 'admin';
  } catch {
    // no-op — 손상된 토큰 등으로 인한 실패는 무시하고 일반 방문자로 집계 계속
  }

  await Promise.allSettled([
    pgRpc('bump_uv_client', { p_date: date, p_ip_bucket: ipBucket, p_cid: cid, p_is_admin: isAdmin }),
    ...(ref ? [pgRpc('bump_ref', { p_date: date, p_ref: ref })] : []),
  ]);

  return NextResponse.json({ ok: true });
}
