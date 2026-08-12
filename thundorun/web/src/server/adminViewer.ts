/**
 * server/adminViewer.ts — "지금 이 요청을 보낸 사람이 관리자인가" 판정 (서버 전용).
 *
 * 조회수처럼 **관리자에게만 보여야 하는 값**을 서버 컴포넌트·라우트 핸들러에서 게이팅할 때 쓴다.
 *
 * 🔴 가리는 게 아니라 **보내지 않는** 용도다. CSS·조건부 스타일로 감추면 숫자가 HTML/RSC
 *    페이로드에 그대로 실려 나가 소스 보기 한 번이면 뚫린다. 호출측은 이 함수가 false 일 때
 *    조회 자체를 건너뛰어야 한다(유출 방지 + 불필요한 DB 왕복 제거).
 *
 * ⚠ ISR 페이지에서는 쓸 수 없다. 캐시된 HTML 은 전 방문자가 공유하므로 세션별로 다를 수 없고,
 *    여기서 세션을 읽으면 그 페이지가 통째로 동적 렌더링으로 강등된다. 홈(revalidate=300)처럼
 *    캐시를 지켜야 하는 화면은 값을 아예 페이로드에서 빼고 클라이언트에서 관리자만 받아온다.
 */
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

/** 세션 객체 → 관리자 여부. 순수함수라 next-auth 없이 단위 테스트할 수 있다. */
export function isAdminSession(session: { user?: { role?: string | null } | null } | null | undefined): boolean {
  return session?.user?.role === 'admin';
}

/** 현재 요청의 관리자 여부. 세션 조회가 실패해도 던지지 않고 false(=비공개)로 닫는다. */
export async function isAdminViewer(): Promise<boolean> {
  try {
    return isAdminSession(await getServerSession(authOptions));
  } catch {
    return false;
  }
}
