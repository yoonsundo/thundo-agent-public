/**
 * traffic.ts — 트래픽 모니터링 공용 유틸 (Edge 미들웨어 + Node 라우트 공용).
 * 설계: PV=서버 미들웨어(차단불가), UV=클라 비콘(천장)+서버 HMAC(바닥).
 * Edge 런타임 안전 — node:crypto 미사용, Web Crypto(crypto.subtle)만 사용.
 */

// ── 추적 대상 공개 경로(엄격 allowlist). 인증/내부/자산 경로는 제외. ──────────────
const TRACK_PREFIXES = ['/blog', '/reports', '/agents'];
const ASSET_RE = /\.[a-z0-9]{1,5}$/i; // .png .svg .ico .js .css .json .xml …
const EXCLUDE_PREFIXES = [
  '/admin', '/api', '/home', '/run', '/dream', '/tarot', '/saju', '/login', '/_next',
];

/** 미들웨어 PV 집계 대상인지 — 공개 콘텐츠 경로만 true. 제외목록·자산은 false. */
export function isPublicTracked(pathname: string): boolean {
  if (!pathname || pathname[0] !== '/') return false;
  if (pathname === '/favicon.ico' || pathname === '/robots.txt' || pathname === '/sitemap.xml') return false;
  for (const p of EXCLUDE_PREFIXES) {
    if (pathname === p || pathname.startsWith(p + '/')) return false;
  }
  if (ASSET_RE.test(pathname)) return false;          // 정적 자산 요청 제외
  if (pathname === '/') return true;                  // 홈
  for (const p of TRACK_PREFIXES) {
    if (pathname === p || pathname.startsWith(p + '/')) return true;
  }
  return false;
}

/**
 * 공개 네임스페이스 — 미들웨어 matcher 에 추가하는 경로 집합과 정확히 일치.
 * 이 경로는 자산/prefetch 라도 인증 fallthrough(/saju/gate 리다이렉트)에 절대 도달시키지 않는다.
 * (Architect 지적: matcher 확장이 access-code fallthrough 를 깨우는 버그 원천 차단)
 */
export function isPublicNamespace(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname === '/blog' || pathname.startsWith('/blog/') ||
    pathname === '/reports' || pathname.startsWith('/reports/') ||
    pathname === '/agents' || pathname.startsWith('/agents/')
  );
}

// ── 봇 UA 탐지(미들웨어 + /api/pv 공용 단일 출처). ──────────────────────────────
const BOT_RE = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|embedly|quora|pinterest|vkshare|whatsapp|telegrambot|headless|monitor|preview|fetch|curl|wget|python-requests|axios|node-fetch|lighthouse|pingdom|uptime|kakaotalk-scrap|discordbot|go-http-client|java(?![sS]cript)|okhttp|ruby|perl|php|dart|dataminr|daum|yeti|bytespider|gptbot|claudebot|ccbot|anthropic|semrush|ahrefs|mj12bot|dotbot|petalbot|applebot/i;

export function isBot(ua: string | null | undefined): boolean {
  if (!ua) return true;                                // UA 없음 = 봇 취급(보수적)
  return BOT_RE.test(ua);
}

/** Referer 헤더에서 host 만 추출(정규화). 동일 출처/빈값은 null. */
export function refHost(referer: string | null | undefined, selfHost?: string | null): string | null {
  if (!referer) return null;
  try {
    const h = new URL(referer).host;
    if (!h || (selfHost && h === selfHost)) return null; // 내부 이동은 리퍼러로 안 셈
    return h.slice(0, 200);
  } catch {
    return null;
  }
}

/** UTC 기준 date(YYYY-MM-DD)·hour(0~23). */
export function dateParts(now: Date): { date: string; hour: number } {
  return { date: now.toISOString().slice(0, 10), hour: now.getUTCHours() };
}

// ── Supabase PostgREST RPC 직접 호출(Edge fetch). service_role 서버 전용. ────────
function supaUrl(): string | null {
  return process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || null;
}
function supaKey(): string | null {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || null;
}

/** RPC 공통 fetch. 실패(미설정·네트워크·!ok)는 모두 null — 호출측에 throw하지 않음(비밀 미노출). */
async function rpcFetch(fn: string, body: Record<string, unknown>): Promise<Response | null> {
  const url = supaUrl();
  const key = supaKey();
  if (!url || !key) return null;
  try {
    const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: key, authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    return res.ok ? res : null;
  } catch {
    return null; // 네트워크/타임아웃 등 — 조용히 실패(트래픽 집계는 best-effort)
  }
}

/** PostgREST RPC 호출(쓰기용). @returns 성공 여부. 렌더/응답을 절대 막지 않는다. */
export async function pgRpc(fn: string, body: Record<string, unknown>): Promise<boolean> {
  return (await rpcFetch(fn, body)) !== null;
}

/** PostgREST RPC 호출 + JSON 결과 반환(읽기용). 실패 시 null. */
export async function pgRpcJson<T = unknown>(fn: string, body: Record<string, unknown>): Promise<T | null> {
  const res = await rpcFetch(fn, body);
  if (!res) return null;
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ── HMAC 방문자 식별자(원본 IP 비가역). Web Crypto HMAC-SHA256. ──────────────────
/**
 * HMAC 키. **하드코딩 폴백을 두지 않는다.**
 *
 * 이전에는 키가 없으면 공개 상수(`'traffic-fallback-secret'`)로 HMAC 을 걸었다. 그건
 * 가명화가 아니다 — 키를 아는 사람은 IP 공간(v4는 유한)을 전수 대입해 **방문자 IP 를 복원**할 수 있다.
 * 게다가 겉으로는 정상 동작해 보여서, 환경변수가 빠진 것을 아무도 모른 채 계속 돌아갔다.
 *
 * 키가 없으면 `null` 을 돌려 **집계를 건너뛴다**. 조회수는 있으면 좋은 부가 기능이고
 * 방문자 프라이버시는 그렇지 않다 — 둘 중 하나를 포기해야 하면 집계를 포기한다.
 */
function hashSecret(): string | null {
  return process.env.TRAFFIC_HASH_SECRET || process.env.NEXTAUTH_SECRET || null;
}

/**
 * 서버 UV 식별자 = HMAC(secret, ip|ua|date). 원본 IP 복원 불가, date별로 값 변경.
 * Edge/Node 모두 globalThis.crypto.subtle 사용.
 */
export async function hmacVisitor(ip: string, ua: string, date: string): Promise<string | null> {
  const secret = hashSecret();
  if (!secret) return null;   // 키 없음 → 가명화 불가 → 집계하지 않는다
  const enc = new TextEncoder();
  const keyData = enc.encode(secret);
  const msg = enc.encode(`${ip}|${ua}|${date}`);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, msg);
  const bytes = new Uint8Array(sig);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex.slice(0, 32); // 128-bit 충분
}

/** 클라이언트 IP 추출(Vercel: x-forwarded-for 첫 항목). */
export function clientIp(headers: Headers): string {
  const xff = headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return headers.get('x-real-ip') || '0.0.0.0';
}

/** prefetch(소프트내비 미리읽기) 요청인지 — PV에서 제외. */
export function isPrefetch(headers: Headers): boolean {
  const secPurpose = headers.get('sec-purpose');       // Chrome Speculation Rules: 'prefetch' | 'prefetch;prerender'
  if (secPurpose && secPurpose.includes('prefetch')) return true;
  return (
    headers.get('next-router-prefetch') === '1' ||
    headers.get('purpose') === 'prefetch' ||
    headers.get('x-purpose') === 'prefetch' ||
    headers.get('x-moz') === 'prefetch'
  );
}
