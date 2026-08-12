/**
 * server/remediation.ts — Goose 자가 조치 승인 큐 서버 유틸 (agents.ts 패턴 미러, 서버 전용)
 *
 * - listRemediations(): /admin/remediation 목록.
 * - decideRemediation(): pending → approved|rejected 전이만 허용(그 외 상태는 no-op).
 *   실제 배포·롤백은 WSL executor 가 approved 를 폴링해 수행 — 웹은 결정만 기록한다.
 *
 * 환경변수: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (서버에서만 사용)
 */
import { getSupabase } from '@/lib/supabase';

export interface RemediationRow {
  id:              string;
  created_at:      string;
  updated_at:      string;
  trigger:         string;
  problem_key:     string;
  observation:     unknown;
  diagnosis:       string;
  plan:            string;
  diff:            string;
  risk:            string;
  status:          string;
  decision_by:     string | null;
  decided_at:      string | null;
  reject_reason:   string | null;
  commit_sha:      string | null;
  deploy_url:      string | null;
  verification:    unknown;
  rolled_back_at:  string | null;
  rollback_reason: string | null;
  error:           string | null;
}

const TABLE = 'remediation_proposals';

export async function listRemediations(limit = 30): Promise<RemediationRow[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from(TABLE)
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('[remediation] list 실패:', error.message);
    return [];
  }
  return (data ?? []) as RemediationRow[];
}

/** pending 상태에서만 결정 가능 — 조건부 update 로 이중 결정·경합을 DB 레벨에서 차단. */
export async function decideRemediation(
  id: string,
  decision: 'approved' | 'rejected',
  actor: string,
  reason?: string,
): Promise<{ ok: boolean; error?: string; row?: RemediationRow }> {
  const db = getSupabase();
  if (!db) return { ok: false, error: 'Supabase 미구성' };
  const { data, error } = await db
    .from(TABLE)
    .update({
      status:        decision,
      decision_by:   actor,
      decided_at:    new Date().toISOString(),
      reject_reason: decision === 'rejected' ? (reason ?? '') : null,
    })
    .eq('id', id)
    .eq('status', 'pending')
    .select();
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) return { ok: false, error: '이미 처리됐거나 존재하지 않는 제안' };
  return { ok: true, row: data[0] as RemediationRow };
}
