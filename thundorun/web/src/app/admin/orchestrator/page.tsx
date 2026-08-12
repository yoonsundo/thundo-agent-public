/**
 * app/admin/orchestrator/page.tsx — 관리자 오케스트레이션 콘솔 (서버 컴포넌트)
 * getServerSession 2차 검증 (role !== 'admin' -> /login).
 */
import { getServerSession }   from 'next-auth';
import { redirect }           from 'next/navigation';
import { authOptions }        from '@/lib/auth';
import OrchestratorConsole    from '@/components/OrchestratorConsole';

export const dynamic  = 'force-dynamic';
export const metadata = { title: '오케스트레이션 콘솔', robots: 'noindex, nofollow' };

export default async function AdminOrchestratorPage() {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') {
    redirect('/login?callbackUrl=/admin/orchestrator');
  }
  // 콘솔이 자체 레이아웃(목록·상세 분할)을 관리한다 → 셸이 준 영역만 넘겨준다.
  return (
    <main>
      <OrchestratorConsole />
    </main>
  );
}
