/**
 * board-approvals.ts — 경영회의 승인 원장 서버 조회·전이.
 *
 * 화면에 "사람 승인 필요"라고만 찍고 승인할 곳이 없던 문제를 메운다(2026-08-21).
 * 쓰기는 관리자 API 만 거친다 — 이 모듈은 service_role 로 접근하므로 라우트에서 role 을 먼저 검증한다.
 */
import { getSupabase } from '@/lib/supabase';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'held';

export interface BoardApproval {
  key: string;
  date: string;
  proposal_id: string;
  team: string | null;
  target: string | null;
  target_type: string | null;
  /** 한 줄 요지 — 승인함에서 제목으로 읽는다. */
  change: string | null;
  /** 실행 방법·단계 — 길 수 있다. 제목이 아니라 본문으로 읽는다. */
  plan?: string | null;
  rationale: string | null;
  expected_effect: string | null;
  value: unknown;
  /** 왜 자동으로 처리하지 않았는지(평문). */
  hold_why: string | null;
  /** 승인하면 무슨 일이 일어나는지(평문). */
  hold_need: string | null;
  status: ApprovalStatus;
  comment: string | null;
  decided_by: string | null;
  decided_at: string | null;
  applied_at: string | null;
  apply_result: unknown;
  created_at: string;
}

/** 승인 대기 + 최근 처리분. 대기가 먼저 오도록 정렬한다(할 일이 위에 보여야 한다). */
export async function listApprovals(limit = 50): Promise<BoardApproval[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from('board_approvals')
    .select('*')
    .order('status', { ascending: true })   // approved < held < pending < rejected (사전순)
    .order('date', { ascending: false })
    .limit(limit);
  if (error) return [];
  const rows = (data ?? []) as BoardApproval[];
  // 사전순 정렬로는 pending 이 위로 오지 않는다 — 할 일 우선으로 다시 세운다.
  const rank: Record<ApprovalStatus, number> = { pending: 0, held: 1, approved: 2, rejected: 3 };
  return rows.sort((a, b) => (rank[a.status] - rank[b.status]) || b.date.localeCompare(a.date));
}

export type TransitionAction = 'approve' | 'reject' | 'hold';

const NEXT_STATUS: Record<TransitionAction, ApprovalStatus> = {
  approve: 'approved', reject: 'rejected', hold: 'held',
};

/**
 * 승인·거부·보류 전이.
 *
 * 규칙 둘:
 *  · **이미 처리된 항목은 다시 처리하지 않는다** — 승인 뒤 실행까지 끝난 걸 되돌리면
 *    원장과 실제 상태가 어긋난다. 되돌리려면 다음 회의에서 새 제안으로 올린다.
 *  · **거부·보류는 코멘트가 필수다** — 이유 없는 거부는 다음 회의가 같은 제안을 또 올리게 만든다.
 */
export async function transitionApproval(
  key: string,
  action: TransitionAction,
  { comment, by }: { comment?: string; by?: string },
): Promise<{ ok: boolean; error?: string; row?: BoardApproval }> {
  if ((action === 'reject' || action === 'hold') && !String(comment ?? '').trim()) {
    return { ok: false, error: action === 'reject' ? '거부 사유를 입력해 주세요' : '보류 사유를 입력해 주세요' };
  }
  const db = getSupabase();
  if (!db) return { ok: false, error: '데이터베이스에 연결할 수 없습니다' };

  const { data: current, error: readErr } = await db
    .from('board_approvals').select('*').eq('key', key).maybeSingle();
  if (readErr || !current) return { ok: false, error: '항목을 찾을 수 없습니다' };
  if ((current as BoardApproval).status !== 'pending') {
    return { ok: false, error: `이미 처리된 항목입니다(현재: ${(current as BoardApproval).status})` };
  }

  const { data, error } = await db
    .from('board_approvals')
    .update({
      status: NEXT_STATUS[action],
      comment: String(comment ?? '').trim() || null,
      decided_by: by ?? null,
      decided_at: new Date().toISOString(),
    })
    .eq('key', key)
    .eq('status', 'pending')          // 동시 클릭 방지 — 조건부 갱신
    .select()
    .maybeSingle();
  if (error || !data) return { ok: false, error: '처리에 실패했습니다' };
  return { ok: true, row: data as BoardApproval };
}
