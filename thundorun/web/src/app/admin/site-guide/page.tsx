/**
 * app/admin/site-guide/page.tsx — 방문자 Q&A (서버 컴포넌트)
 *
 * 홈 메인에서 내리고(2026-08-07 사용자 결정) 관리자 아래로 옮긴 화면이다.
 * 컴포넌트(`SiteGuideChat`)와 응답 로직(`/api/site-chat`)은 그대로 살아 있으므로,
 * 여기서 방문자가 보던 것과 **같은 답변**을 확인할 수 있다.
 *
 * 미들웨어 1차 차단 + getServerSession 2차 검증(role !== 'admin' → /login) — 다른 admin 라우트와 동일.
 *
 * ⚠ 화면만 내린 것이고 `/api/site-chat` 자체는 여전히 공개 엔드포인트다(직접 POST 하면 응답한다).
 *   완전히 닫으려면 그 라우트에 admin 게이트를 걸어야 한다 — 이번 변경 범위 밖.
 */
import { getServerSession } from 'next-auth';
import { redirect }         from 'next/navigation';
import { authOptions }      from '@/lib/auth';
import SiteGuideChat        from '@/components/SiteGuideChat';

export const dynamic  = 'force-dynamic';
export const metadata = { title: '방문자 Q&A', robots: 'noindex, nofollow' };

export default async function AdminSiteGuidePage() {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') {
    redirect('/login?callbackUrl=/admin/site-guide');
  }

  return (
    <main className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">방문자 Q&amp;A</h1>
          <p className="page-sub">
            홈에 있던 질문·답변 화면입니다. 지금은 메인에서 내려 관리자만 볼 수 있고,
            답변 내용은 방문자에게 보이던 것과 동일합니다.
          </p>
        </div>
      </header>
      <SiteGuideChat />
    </main>
  );
}
