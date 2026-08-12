/**
 * app/admin/portfolio-2/page.tsx — 현업 담당자 관점의 카테고리형 포트폴리오 미리보기.
 */
import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { listProjects } from '@/server/projects';
import PortfolioPreview2 from '@/components/PortfolioPreview2';

export const dynamic = 'force-dynamic';
export const metadata = { title: '포트폴리오 미리보기 2', robots: 'noindex, nofollow' };

export default async function AdminPortfolioPreview2Page() {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') {
    redirect('/login?callbackUrl=/admin/portfolio-2');
  }

  const projects = await listProjects();
  return <PortfolioPreview2 projects={projects} />;
}
