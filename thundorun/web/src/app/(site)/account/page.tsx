/**
 * /account — 마이페이지 (로그인 사용자 전용)
 *
 * 미들웨어(/account 로그인 게이트)가 1차 방어. 서버 컴포넌트에서 세션 재검증(defense-in-depth)
 * 후, 미검출 시 콜백과 함께 /login 으로 리다이렉트.
 */
import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import PasswordChangeForm from './PasswordChangeForm';

export const metadata = {
  title: '마이페이지 — Thundo',
};

// 세션 기반 개인 페이지 — 정적 캐시 금지.
export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  const session = await getServerSession(authOptions);
  if (!session) {
    redirect('/login?callbackUrl=/account');
  }

  const userId = session.user?.name ?? session.user?.email ?? '알 수 없음';
  const role = session.user?.role ?? 'user';
  const roleLabel = role === 'admin' ? '관리자' : '일반 사용자';

  return (
    <div className="container-narrow">
      <div className="page-head">
        <div>
          <h1 className="page-title">마이페이지</h1>
          <p className="page-sub">계정 정보 확인 및 비밀번호 변경</p>
        </div>
      </div>

      <div className="stack-6">
        {/* 계정 정보 카드 */}
        <section className="card">
          <h2 className="card-kicker">계정 정보</h2>
          <dl className="dl">
            <dt>아이디</dt><dd>{userId}</dd>
            <dt>권한</dt><dd>{roleLabel}</dd>
          </dl>
        </section>

        {/* 비밀번호 변경 카드 */}
        <section className="card">
          <h2 className="card-kicker">비밀번호 변경</h2>
          <PasswordChangeForm />
        </section>
      </div>
    </div>
  );
}
