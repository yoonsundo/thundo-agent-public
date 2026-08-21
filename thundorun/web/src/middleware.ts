import { withAuth, type NextRequestWithAuth } from 'next-auth/middleware';
import { getToken } from 'next-auth/jwt';
import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server';
import { resolveAccessCode, accessCodeToken } from '@/lib/accessCode';
import {
  isPublicNamespace, isPublicTracked, isBot, isPrefetch,
  pgRpc, hmacVisitor, clientIp, refHost, dateParts,
} from '@/lib/traffic';

// saju/amond 전용 — 기존 로그인 페이지 유지 (RunRun 하위 호환)
const sajuAmondAuth = withAuth({ pages: { signIn: '/saju/amond/login' } });

// ── 공통 헬퍼: 로그인 필요 게이트 ──────────────────────────────────────────────
async function requireLogin(req: NextRequest, pathname: string) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(url);
  }
  return null; // 통과
}

export default async function middleware(req: NextRequest, event: NextFetchEvent) {
  const { pathname } = req.nextUrl;

  // ── /agents, /reports — 2026-08-21 다시 **공개**로 전환(2026-07-06 로그인 전용에서 되돌림). ──
  // 공개 전 실제 렌더 내용을 훑어 확인했다: 크리덴셜·이메일·서버 IP·거래처 정보 없음.
  // 경영회의에 운영 실패가 솔직하게 적히지만(예: "감사가 깨졌을 수도"), 그것을 숨기지 않는 것이
  // 이 시스템의 증거라고 판단했다(사용자 결정). 사람 판단이 필요한 안건과 승인은 여전히
  // /admin/board 에서만 다룬다 — 공개되는 것은 **읽기**뿐이다.
  //
  // ⚠ 이 두 경로에 새 정보를 실을 때는 공개 화면임을 전제로 볼 것.

  // ── 트래픽 PV 집계 — 추적 네임스페이스(/, /blog + 로그인 게이트 통과한 /reports, /agents) early-return. ──
  // 인증/access-code 분기 이전에 반환해 fallthrough(/saju/gate 리다이렉트)를 원천 차단.
  // PV 는 서버사이드 카운트(광고차단 불가). waitUntil 로 비차단 — 집계 실패해도 렌더 영향 없음.
  if (isPublicNamespace(pathname)) {
    const ua = req.headers.get('user-agent');
    // sec-fetch-mode 게이트: 헤더 부재(구브라우저)는 허용, 존재하면 navigate(실제 페이지 이동)만 집계.
    // cors/no-cors/same-origin 등 리소스·프리페치성 요청은 제외.
    const secFetchMode = req.headers.get('sec-fetch-mode');
    if (req.method === 'GET' && isPublicTracked(pathname) && !isPrefetch(req.headers) && !isBot(ua)
        && (secFetchMode === null || secFetchMode === 'navigate')) {
      const { date, hour } = dateParts(new Date());
      const ip = clientIp(req.headers);
      const ref = refHost(req.headers.get('referer'), req.nextUrl.host);
      event.waitUntil((async () => {
        // 관리자(role=admin) 본인 테스트 방문 태깅 — 집계는 하되 실제 트래픽과 분리.
        // waitUntil 내부(비차단)에서 getToken 호출 → 렌더 영향 0. 익명은 토큰 없음 → false.
        // getToken throw(손상된 세션 쿠키 등) 방어 — 실패해도 집계 자체는 그대로 진행(isAdmin=false 폴백).
        let isAdmin = false;
        try {
          const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
          isAdmin = token?.role === 'admin';
        } catch {
          // no-op — 손상된 토큰 등으로 인한 실패는 무시하고 일반 방문자로 집계 계속
        }
        const visitor = await hmacVisitor(ip, ua || '', date);
        // 가명화 키가 없으면 집계를 건너뛴다 — 원본 IP 를 복원 가능한 형태로 남기지 않는다.
        if (!visitor) return;
        await Promise.allSettled([
          pgRpc('bump_pv_guarded', { p_date: date, p_hour: hour, p_path: pathname, p_visitor: visitor, p_is_admin: isAdmin }),
          pgRpc('bump_uv', { p_date: date, p_visitor: visitor, p_source: 'server', p_is_admin: isAdmin }),
          ...(ref ? [pgRpc('bump_ref', { p_date: date, p_ref: ref })] : []),
        ]);
      })());
    }
    // 집계 여부와 무관하게 공개 경로는 항상 통과(인증 분기 미도달).
    return NextResponse.next();
  }

  // ── /api/admin/** — admin role 전용 (API: 401 JSON 반환) ─────────────────
  if (pathname.startsWith('/api/admin')) {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
    if (!token || token.role !== 'admin') {
      return NextResponse.json({ error: '인증 필요' }, { status: 401 });
    }
    return NextResponse.next();
  }

  // ── /admin/** — admin role 전용 (페이지: /login 리다이렉트) ───────────────
  if (pathname.startsWith('/admin')) {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
    if (!token || token.role !== 'admin') {
      const url = req.nextUrl.clone();
      url.pathname = '/login';
      url.searchParams.set('callbackUrl', pathname);
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  // ── /account/**, /api/account/** — 로그인 필요 (마이페이지·비밀번호 변경) ──
  if (pathname.startsWith('/account') || pathname.startsWith('/api/account')) {
    const res = await requireLogin(req, pathname);
    if (res) return res;
    return NextResponse.next();
  }

  // ── /home/** — 로그인 필요 (NEW) ─────────────────────────────────────────
  if (pathname.startsWith('/home')) {
    const res = await requireLogin(req, pathname);
    if (res) return res;
    return NextResponse.next();
  }

  // ── /run/** — 로그인 필요 (NEW) ──────────────────────────────────────────
  if (pathname.startsWith('/run')) {
    const res = await requireLogin(req, pathname);
    if (res) return res;
    return NextResponse.next();
  }

  // ── /dream/**, /api/dream/** — 로그인 필요 (NEW) ─────────────────────────
  if (pathname.startsWith('/dream') || pathname.startsWith('/api/dream')) {
    const res = await requireLogin(req, pathname);
    if (res) return res;
    return NextResponse.next();
  }

  // ── /tarot/**, /api/tarot/** — 로그인 필요 (NEW) ─────────────────────────
  if (pathname.startsWith('/tarot') || pathname.startsWith('/api/tarot')) {
    const res = await requireLogin(req, pathname);
    if (res) return res;
    return NextResponse.next();
  }

  // ── /saju/amond/** — 기존 next-auth 세션 보호 (RunRun 유지) ─────────────
  if (pathname.startsWith('/saju/amond')) {
    if (pathname.startsWith('/saju/amond/login')) return NextResponse.next();
    return sajuAmondAuth(req as NextRequestWithAuth, event);
  }

  // ── /saju/** — 로그인 필요 + saju 비밀코드 게이트 (보존) ─────────────────
  // 로그인 체크 먼저, 그 다음 기존 access-code 게이트
  if (pathname.startsWith('/saju') || pathname.startsWith('/api/saju')) {
    // saju/gate 와 api/saju/gate 는 공개 (access-code 입력 폼)
    const isGate = pathname === '/saju/gate' || pathname === '/api/saju/gate';
    if (!isGate) {
      const res = await requireLogin(req, pathname);
      if (res) return res;
    }
  }

  // ── saju 비밀코드 게이트 (SAJU_ACCESS_CODE 미설정 시 비활성) ──────────────
  const accessCode = resolveAccessCode();
  if (!accessCode) return NextResponse.next();

  if (pathname === '/saju/gate' || pathname === '/api/saju/gate') return NextResponse.next();

  const cookie = req.cookies.get('saju_gate')?.value;
  if (cookie && cookie === (await accessCodeToken(accessCode))) return NextResponse.next();

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: '접근 코드가 필요합니다.' }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.pathname = '/saju/gate';
  url.search = '';
  if (pathname !== '/saju') url.searchParams.set('next', pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    '/',                   // 트래픽 PV — 홈
    '/blog/:path*',        // 트래픽 PV — 블로그(목록·상세)
    '/reports/:path*',     // 트래픽 PV — 운영보고
    '/agents',             // 트래픽 PV — 에이전트 소개
    '/agents/:path*',
    '/api/admin/:path*',   // defense-in-depth — API 레벨 admin 차단
    '/admin/:path*',
    '/account',
    '/account/:path*',
    '/api/account/:path*',
    '/home',
    '/home/:path*',
    '/run',
    '/run/:path*',
    '/dream/:path*',
    '/api/dream/:path*',
    '/tarot/:path*',
    '/api/tarot/:path*',
    '/saju/:path*',
    '/api/saju/:path*',
  ],
};
