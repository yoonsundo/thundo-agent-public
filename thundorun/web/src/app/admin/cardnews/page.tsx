/**
 * app/admin/cardnews/page.tsx — 인스타 카드뉴스 반자동 발행 (서버 컴포넌트)
 * 미들웨어 1차 차단 + getServerSession 2차 검증(role !== 'admin' -> /login).
 */
import { getServerSession } from 'next-auth';
import { redirect }         from 'next/navigation';
import { authOptions }      from '@/lib/auth';
import CardnewsAdmin        from '@/components/CardnewsAdmin';

export const dynamic = 'force-dynamic';
export const metadata = { title: '카드뉴스 발행', robots: 'noindex, nofollow' };

export default async function AdminCardnewsPage() {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') {
    redirect('/login?callbackUrl=/admin/cardnews');
  }
  return <CardnewsAdmin />;
}
