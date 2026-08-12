/**
 * app/admin/projects/page.tsx — 관리자 프로젝트 CRUD 페이지(서버 컴포넌트)
 * 미들웨어 1차 차단 + getServerSession 2차 검증(role !== 'admin' → /login).
 * 셸(사이드바·톱바)은 app/admin/layout.tsx, 페이지 골격(.page)은 ProjectsAdmin 이 담당.
 */
import { getServerSession } from 'next-auth';
import { redirect }         from 'next/navigation';
import { authOptions }      from '@/lib/auth';
import ProjectsAdmin        from '@/components/ProjectsAdmin';

export const dynamic = 'force-dynamic';
export const metadata = { title: '프로젝트 관리', robots: 'noindex, nofollow' };

export default async function AdminProjectsPage() {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') {
    redirect('/login?callbackUrl=/admin/projects');
  }
  return <ProjectsAdmin />;
}
