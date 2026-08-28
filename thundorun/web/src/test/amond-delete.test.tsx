/**
 * amond-delete — 아몬드(사주 관제) 대시보드 조회 이력 삭제.
 *
 * ① 라우트 3종의 DELETE 를 **실제로 호출**한다 (미인증 401 · id 누락 400 · 없는 id 404 · 정상 200).
 * ② 화면을 실제로 렌더해 삭제 동선을 누른다 — 확인 다이얼로그 없이 지워지면 안 되고(파괴적 액션),
 *    서버가 성공해야만 행이 사라져야 한다.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextRequest } from 'next/server';

vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/supabase', () => ({ getSupabase: vi.fn() }));

import { getServerSession } from 'next-auth';
import { getSupabase } from '@/lib/supabase';
import { DELETE as deleteSaju } from '@/app/api/admin/readings/route';
import { DELETE as deleteDream } from '@/app/api/admin/dream-readings/route';
import { DELETE as deleteTarot } from '@/app/api/admin/tarot-readings/route';
import AmondPage from '@/app/saju/amond/page';

const asAdmin = () =>
  (getServerSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { role: 'admin' } });

/** delete().eq().select() 체인을 기록하는 최소 대역. */
function fakeDb(result: { data?: unknown; error?: unknown }) {
  const rec: { table: string; id: string | null } = { table: '', id: null };
  const builder = {
    delete: () => builder,
    eq: (_k: string, v: string) => { rec.id = v; return builder; },
    select: () => Promise.resolve(result),
  };
  (getSupabase as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    from: (t: string) => { rec.table = t; return builder; },
  });
  return rec;
}

const req = (id?: string) =>
  new NextRequest(`http://x/api/admin/readings${id ? `?id=${id}` : ''}`, { method: 'DELETE' });

beforeEach(() => vi.clearAllMocks());

describe('DELETE 라우트 3종', () => {
  it('미인증이면 401 — DB 에 닿지 않는다', async () => {
    (getServerSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    expect((await deleteSaju(req('x'))).status).toBe(401);
    expect(getSupabase).not.toHaveBeenCalled();
  });

  it('id 없으면 400', async () => {
    asAdmin();
    expect((await deleteSaju(req())).status).toBe(400);
  });

  it('없는 id 면 404 — 0행 삭제를 성공으로 보고하지 않는다', async () => {
    asAdmin();
    fakeDb({ data: [], error: null });
    expect((await deleteSaju(req('없는-id'))).status).toBe(404);
  });

  it('각 라우트가 자기 테이블만 지운다', async () => {
    asAdmin();
    for (const [handler, table] of [
      [deleteSaju, 'saju_readings'],
      [deleteDream, 'dream_readings'],
      [deleteTarot, 'tarot_readings'],
    ] as const) {
      const rec = fakeDb({ data: [{ id: 'r1' }], error: null });
      const res = await handler(req('r1'));
      expect(res.status).toBe(200);
      expect(rec.table).toBe(table);
      expect(rec.id).toBe('r1');
    }
  });
});

// ── 화면 동선 ────────────────────────────────────────────────────────────────

vi.mock('next-auth/react', () => ({
  useSession: () => ({ status: 'authenticated' }),
  signOut: vi.fn(),
}));
// ⚠ 라우터는 **안정 참조**여야 한다 — 렌더마다 새 객체를 주면 페이지의 useEffect([status, router])
//    가 무한 재실행돼 GET 이 계속 목록을 되살린다(실제 useRouter 는 참조가 안정적이다).
const stableRouter = { push: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => stableRouter }));
// jsdom 에 markdown 렌더까지 물릴 필요 없다 — 이 테스트의 관심사는 삭제 동선이다.
vi.mock('react-markdown', () => ({ default: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock('remark-gfm', () => ({ default: () => null }));

const ROW = {
  id: 'r1', name: '황다은', birth_date: '1999-01-28', birth_time: '23:49', gender: 'female',
  fortune_types: ['원국'], result: '# 결과', created_at: '2026-07-10T14:31:23Z',
};

function stubPageFetch(opts: { deleteOk: boolean }) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'DELETE') {
      return { ok: opts.deleteOk, status: opts.deleteOk ? 200 : 404, json: async () => (opts.deleteOk ? { ok: true } : { error: '해당 이력을 찾지 못했다' }) };
    }
    return { ok: true, json: async () => ({ items: [ROW], total: 1 }) };
  }) as unknown as typeof fetch;
}

describe('아몬드 화면 삭제 동선', () => {
  it('삭제는 확인을 거친다 — 누르자마자 지워지면 안 된다', async () => {
    global.fetch = stubPageFetch({ deleteOk: true });
    const user = userEvent.setup();
    render(<AmondPage />);

    await user.click(await screen.findByRole('button', { name: '삭제' }));
    // 다이얼로그가 떴을 뿐, 아직 DELETE 는 안 나갔다
    expect(screen.getByText(/조회 이력을 삭제할까요/)).toBeInTheDocument();
    const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.filter((c) => (c[1] as RequestInit)?.method === 'DELETE')).toHaveLength(0);

    // 다이얼로그의 [삭제] 확정 → 행이 사라지고 총계가 준다 (행의 삭제 버튼과 이름이 같아 다이얼로그로 스코프)
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '삭제' }));
    await waitFor(() => expect(screen.queryByText('황다은')).toBeNull());
    // 마지막 1건을 지웠으므로 빈 상태로 전환된다 (0건 카운트가 아니라 Empty 렌더)
    expect(screen.getByText(/조회 이력이 없습니다/)).toBeInTheDocument();
  });

  it('서버가 거부하면 행이 남고 오류가 보인다 — 화면만 지워지는 거짓 성공 금지', async () => {
    global.fetch = stubPageFetch({ deleteOk: false });
    const user = userEvent.setup();
    render(<AmondPage />);

    await user.click(await screen.findByRole('button', { name: '삭제' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '삭제' }));

    await waitFor(() => expect(screen.getByText(/해당 이력을 찾지 못했다/)).toBeInTheDocument());
    expect(screen.getByText('황다은')).toBeInTheDocument();
    expect(screen.getByText(/총 조회 수: 1건/)).toBeInTheDocument();
  });
});
