/**
 * server/agents.ts — 에이전트 소개 서버 유틸 (서버 전용, projects.ts 패턴 미러)
 *
 * - getActiveAgents(): 공개 /agents 페이지용. active=true 만 sort_order 순.
 *   테이블 없음/오류 시 빈 배열 → 페이지는 빈 상태 안내를 렌더(죽지 않음).
 * - listAgents/upsertAgent/deleteAgent: 관리자 CRUD (/api/admin/agents 전용).
 *
 * 환경변수: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (서버에서만 사용)
 */
import { getSupabase } from '@/lib/supabase';

export interface AgentRow {
  id:          string;
  name:        string;
  role:        string;
  description: string;
  image_url:   string | null;
  emoji:       string;
  sort_order:  number;
  active:      boolean;
}

/** DB row → AgentRow 정규화(부분/형식이상 방어). */
function normalize(r: Record<string, unknown>): AgentRow {
  return {
    id:          String(r.id ?? ''),
    name:        String(r.name ?? ''),
    role:        String(r.role ?? ''),
    description: String(r.description ?? ''),
    image_url:   r.image_url ? String(r.image_url) : null,
    emoji:       String(r.emoji ?? ''),
    sort_order:  typeof r.sort_order === 'number' ? r.sort_order : 0,
    active:      r.active !== false,
  };
}

/** getActiveAgents() — 공개 페이지용. 오류 시 빈 배열(폴백 없음, UI가 빈 상태 렌더). */
export async function getActiveAgents(): Promise<AgentRow[]> {
  const db = getSupabase();
  if (!db) return [];
  try {
    const { data, error } = await db
      .from('agents')
      .select('*')
      .eq('active', true)
      .order('sort_order', { ascending: true });
    if (error || !Array.isArray(data)) return [];
    return data.map(normalize);
  } catch {
    return [];
  }
}

/** listAgents() — 관리자용(active 무관 전체). */
export async function listAgents(): Promise<AgentRow[]> {
  const db = getSupabase();
  if (!db) return [];
  try {
    const { data, error } = await db
      .from('agents')
      .select('*')
      .order('sort_order', { ascending: true });
    if (error || !Array.isArray(data)) return [];
    return data.map(normalize);
  } catch {
    return [];
  }
}

type SaveResult = { ok: boolean; error?: string };

/** upsertAgent — 추가/수정 겸용(on conflict id). */
export async function upsertAgent(a: AgentRow): Promise<SaveResult> {
  const db = getSupabase();
  if (!db) return { ok: false, error: 'Supabase 미연결' };
  if (!a.id || !a.name) return { ok: false, error: 'id·name 필수' };
  try {
    const { error } = await db.from('agents').upsert({
      id:          a.id,
      name:        a.name,
      role:        a.role ?? '',
      description: a.description ?? '',
      image_url:   a.image_url ?? null,
      emoji:       a.emoji ?? '',
      sort_order:  typeof a.sort_order === 'number' ? a.sort_order : 0,
      active:      a.active !== false,
      updated_at:  new Date().toISOString(),
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function deleteAgent(id: string): Promise<SaveResult> {
  const db = getSupabase();
  if (!db) return { ok: false, error: 'Supabase 미연결' };
  if (!id) return { ok: false, error: 'id 필수' };
  try {
    const { error } = await db.from('agents').delete().eq('id', id);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
