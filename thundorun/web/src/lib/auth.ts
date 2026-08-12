/**
 * lib/auth.ts — next-auth 설정 (서버 전용)
 *
 * 인증 흐름:
 *   1. Supabase admin_users 테이블 조회 → scrypt 검증 → role 포함 반환.
 *   2. Supabase 미연결 시 + ALLOW_ENV_ADMIN=1: env ADMIN_EMAIL/ADMIN_PASSWORD 비교
 *      (timingSafeEqual 사용). prod 에서 ALLOW_ENV_ADMIN 미설정이면 null 반환.
 *
 * MED-5: NEXTAUTH_SECRET 미설정 또는 32바이트 미만 → prod 기동 거부 / dev 경고.
 * MED-4: 평문 env 폴백 prod 허용 조건 = ALLOW_ENV_ADMIN==='1' 만.
 * JWT/세션 콜백으로 role 필드 전파.
 * 로그인 페이지: /login (사이트 공통). saju/amond 미들웨어는 별도 withAuth 사용.
 */
import type { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import { timingSafeEqual } from 'crypto';
import { getSupabase } from '@/lib/supabase';
import { verifyPassword, dummyVerify } from '@/lib/authScrypt';

// ── MED-5: NEXTAUTH_SECRET fail-fast ─────────────────────────────────────────
// NEXT_PHASE=phase-production-build 은 next build 중 정적 수집 단계.
// 런타임 시작 시(실 요청 처리)만 throw 해야 빌드가 통과됨.
(function checkSecret() {
  const secret   = process.env.NEXTAUTH_SECRET ?? '';
  const isBuild  = process.env.NEXT_PHASE === 'phase-production-build';
  const isProd   = !isBuild && (process.env.NODE_ENV === 'production' || process.env.VERCEL === '1');
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
    if (isProd) {
      throw new Error(
        '[auth] NEXTAUTH_SECRET 미설정 또는 32바이트 미만 — 프로덕션 기동 거부. ' +
        '`openssl rand -base64 32` 로 생성 후 환경변수에 등록하세요.'
      );
    } else {
      // eslint-disable-next-line no-console
      console.warn('[auth] 경고: NEXTAUTH_SECRET 미설정/32바이트 미만 (개발환경 허용, 프로덕션에서는 기동 거부)');
    }
  }
})();

// ── MED-4: timing-safe 문자열 비교 ───────────────────────────────────────────
function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) {
    // 길이 다름 → dummy compare 로 타이밍 사이드채널 방지 후 false 반환
    const dummy = Buffer.alloc(aBuf.length);
    timingSafeEqual(aBuf, dummy);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        // email 필드를 사용자 ID로 처리 (saju/amond/login 하위 호환 유지).
        email:    { label: '아이디',   type: 'text'     },
        password: { label: '비밀번호', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        const userId = credentials.email.trim();
        const pw     = credentials.password;

        // ── 1. Supabase admin_users 조회 ─────────────────────────────────
        const db = getSupabase();
        if (db) {
          const { data, error } = await db
            .from('admin_users')
            .select('id, password_hash, role')
            .eq('id', userId)
            .maybeSingle();

          if (error) {
            dummyVerify(pw); // DB 오류: 타이밍 사이드채널 제거 후 거부
            return null;
          }

          if (!data) {
            dummyVerify(pw); // 사용자 미존재 — 타이밍 사이드채널 제거
            return null;
          }

          const ok = verifyPassword(pw, data.password_hash as string);
          if (!ok) return null;

          return {
            id:    data.id as string,
            name:  data.id as string,
            email: data.id as string,
            role:  (data.role as string) ?? 'user',
          };
        }

        // ── 2. Supabase 미연결 — env 폴백 ────────────────────────────────
        // MED-4: prod 에서는 ALLOW_ENV_ADMIN=1 명시적 허용 시만 사용.
        //        미설정이면 Supabase admin_users 강제 → null 반환.
        const isProd = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';
        if (isProd && process.env.ALLOW_ENV_ADMIN !== '1') return null;

        const adminEmail    = process.env.ADMIN_EMAIL;
        const adminPassword = process.env.ADMIN_PASSWORD;
        if (!adminEmail || !adminPassword) return null;

        // MED-4: 평문 비교 → timingSafeEqual 로 교체
        const idOk = timingSafeStringEqual(userId, adminEmail);
        const pwOk = timingSafeStringEqual(pw,     adminPassword);
        if (!idOk || !pwOk) return null;

        return {
          id:    '1',
          email: adminEmail,
          name:  '관리자',
          role:  'admin',
        };
      },
    }),
  ],

  callbacks: {
    async jwt({ token, user }) {
      // 최초 로그인 시 user 객체에서 role 추출해 토큰에 저장
      if (user?.role) token.role = user.role;
      return token;
    },
    async session({ session, token }) {
      if (token.role) session.user.role = token.role;
      return session;
    },
  },

  pages:   { signIn: '/login' },
  secret:  process.env.NEXTAUTH_SECRET,
  session: { strategy: 'jwt' },
};
