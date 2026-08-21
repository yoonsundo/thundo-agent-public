/**
 * app/admin/board/page.tsx — 경영회의 승인함 (서버 컴포넌트)
 * 미들웨어 1차 차단 + getServerSession 2차 검증(role !== 'admin' -> /login).
 */
import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { listApprovals } from '@/server/board-approvals';
import BoardApprovalList from '@/components/BoardApprovalList';

export const dynamic = 'force-dynamic';
export const metadata = { title: '경영회의 승인함', robots: 'noindex, nofollow' };

export default async function AdminBoardPage() {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') {
    redirect('/login?callbackUrl=/admin/board');
  }
  const items = await listApprovals();
  return <BoardApprovalList items={items} />;
}
