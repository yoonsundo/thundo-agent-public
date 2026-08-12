/**
 * app/admin/chat/page.tsx — 에이전트 채팅 페이지 (서버 컴포넌트)
 * getServerSession 2차 검증 (role !== 'admin' -> /login).
 */
import { getServerSession } from 'next-auth';
import { redirect }         from 'next/navigation';
import { authOptions }      from '@/lib/auth';
import AgentChat            from '@/components/AgentChat';

export const dynamic = 'force-dynamic';
export const metadata = { title: '에이전트 채팅', robots: 'noindex, nofollow' };

export default async function AdminChatPage() {
  const session = await getServerSession(authOptions);
  if (!session || session.user?.role !== 'admin') {
    redirect('/login?callbackUrl=/admin/chat');
  }
  // 채팅 화면은 높이를 자기가 관리한다(.chat-log 가 flex:1) → 셸이 준 영역만 넘겨준다.
  return (
    <main>
      <AgentChat />
    </main>
  );
}
