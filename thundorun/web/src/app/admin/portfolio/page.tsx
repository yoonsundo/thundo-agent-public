/**
 * app/admin/portfolio/page.tsx — 포트폴리오 미리보기 (서버 컴포넌트)
 * 미들웨어 1차 차단 + getServerSession 2차 검증(role !== 'admin' → /login).
 * 사용자에게 보일 화면을 관리자 아래에서만 확인한다.
 * ⚠ detail 내용(summary·flow·personas·tech)은 2026-08-06 사용자 결정으로 사이트챗 상세 답변
 *   (siteGuide.ts projectDetailAnswer)을 통해 공개 노출된다 — 더 이상 관리자 전용 데이터가 아니다.
 * 데이터는 listProjects()(service_role, detail 포함) — 폴백 없이 DB 그대로.
 */
import { getServerSession } from 'next-auth';
import { redirect }         from 'next/navigation';
import { authOptions }      from '@/lib/auth';
import { listProjects }     from '@/server/projects';
import PortfolioPreview     from '@/components/PortfolioPreview';

export const dynamic  = 'force-dynamic';
export const metadata = { title: '포트폴리오 미리보기', robots: 'noindex, nofollow' };

export default async function AdminPortfolioPage() {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') {
    redirect('/login?callbackUrl=/admin/portfolio');
  }
  const projects = await listProjects();
  return <PortfolioPreview projects={projects} />;
}
