/**
 * server/projects.ts — 프로젝트 서버 유틸 (서버 전용)
 *
 * - getProjects(): service_role 로 projects 테이블 읽기. 테이블 없음/비어있음/오류 시
 *   기본 콘텐츠(projects.default.json — 에이전트 생태계)로 폴백. (getProfile 패턴 동일)
 * - 관리자 CRUD: listProjects/createProject/updateProject/deleteProject.
 *
 * 환경변수: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 * 폴백 덕분에 projects 테이블이 아직 없어도 메인페이지는 기본 콘텐츠를 정상 렌더한다.
 */
import { getSupabase } from '@/lib/supabase';
import defaults from './projects.default.json';

// ProjectsDashboard 의 Project 형태와 호환(추가 필드 id/sort_order 는 무시됨).
export interface ProjectRow {
  id:          string;
  title:       string;
  period:      string;
  role?:       string;
  stack:       string[];
  description: string;
  highlights:  string[];
  link:        string | null;
  sort_order:  number;
  /** 상단 고정(최대 6). 상한의 최종 소유자는 DB 트리거다 — supabase/projects_pinned.sql */
  pinned:      boolean;
  /** 고정된 시각. 트리거가 채우고 지운다(앱이 직접 쓰지 않는다). */
  pinned_at:   string | null;
  /** 포트폴리오 상세 — 미보유(기존 데이터·admin 폼 경유)면 undefined/null. upsert 는 이 필드를 보내지 않아 DB 값을 보존한다. */
  detail?:     ProjectDetail | null;
}

/**
 * 포트폴리오 상세(`/admin/portfolio` 미리보기) — projects.detail jsonb.
 * flow 는 "순차 다이어그램 + 아래 1·2·3 번호 설명"의 단일 소스이고,
 * personas 는 같은 프로젝트를 인사담당자/현업담당자/CEO 관점으로 각각 쓴 문단이다.
 */
export interface ProjectDetail {
  summary:  string;
  flow:     Array<{ label: string; desc: string }>;
  personas: { hr: string; field: string; ceo: string };
  /** 미리보기 2 분류. 기존 데이터는 프로젝트 ID 기반 분류로 폴백한다. */
  category?: 'personal' | 'career';
  /** 기술 노트 — 개발자용 스택·API 설명을 비개발자도 읽히는 쉬운 문장으로. 없으면 섹션 미표시. */
  tech?:    string[];
}

/** detail jsonb → ProjectDetail 정규화. 형태가 어긋나면 null(화면은 기본 필드로 폴백). */
function normalizeDetail(v: unknown): ProjectDetail | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const d = v as Record<string, unknown>;
  const personas = (d.personas && typeof d.personas === 'object' && !Array.isArray(d.personas))
    ? d.personas as Record<string, unknown> : {};
  const flow = Array.isArray(d.flow)
    ? d.flow
        .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
        .map((s) => ({ label: String(s.label ?? ''), desc: String(s.desc ?? '') }))
        .filter((s) => s.label && s.desc)
    : [];
  return {
    summary: String(d.summary ?? ''),
    flow,
    personas: {
      hr:    String(personas.hr ?? ''),
      field: String(personas.field ?? ''),
      ceo:   String(personas.ceo ?? ''),
    },
    category: d.category === 'personal' || d.category === 'career' ? d.category : undefined,
    tech: Array.isArray(d.tech) ? d.tech.map(String).filter(Boolean) : undefined,
  };
}

const DEFAULT_PROJECTS = (defaults as Array<Omit<ProjectRow, 'pinned' | 'pinned_at'>>)
  .map((p) => ({ ...p, pinned: false, pinned_at: null })) as ProjectRow[];

/** 고정 먼저(최근 고정 순) → 나머지는 기존 sort_order. 목록 화면들이 같은 순서를 공유한다. */
export function sortProjects(rows: ProjectRow[]): ProjectRow[] {
  return [...rows].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned && b.pinned) {
      const ta = a.pinned_at ?? '', tb = b.pinned_at ?? '';
      if (ta !== tb) return tb.localeCompare(ta);
    }
    return a.sort_order - b.sort_order;
  });
}

/** 현재 고정 건수 — UI 가 상한 도달을 미리 알려주기 위해 쓴다(강제는 DB 트리거). */
export const PIN_MAX = 6;

/** DB row → ProjectRow 정규화(부분/형식이상 방어). */
function normalize(r: Record<string, unknown>): ProjectRow {
  return {
    id:          String(r.id ?? ''),
    title:       String(r.title ?? ''),
    period:      String(r.period ?? ''),
    role:        r.role ? String(r.role) : undefined,
    stack:       Array.isArray(r.stack) ? (r.stack as string[]) : [],
    description: String(r.description ?? ''),
    highlights:  Array.isArray(r.highlights) ? (r.highlights as string[]) : [],
    link:        r.link ? String(r.link) : null,
    sort_order:  typeof r.sort_order === 'number' ? r.sort_order : 0,
    pinned:      r.pinned === true,
    pinned_at:   typeof r.pinned_at === 'string' ? r.pinned_at : null,
    detail:      normalizeDetail(r.detail),
  };
}

/** getProjects() — 공개 메인페이지용. DB 우선, 없으면 기본 콘텐츠 폴백. */
export async function getProjects(): Promise<ProjectRow[]> {
  const db = getSupabase();
  if (!db) return DEFAULT_PROJECTS;
  try {
    const { data, error } = await db
      .from('projects')
      .select('*')
      .order('sort_order', { ascending: true });
    if (error || !Array.isArray(data) || data.length === 0) return DEFAULT_PROJECTS;
    return sortProjects(data.map(normalize));
  } catch {
    return DEFAULT_PROJECTS;
  }
}

/** listProjects() — 관리자용(폴백 없이 DB 그대로, 비었으면 빈 배열). */
export async function listProjects(): Promise<ProjectRow[]> {
  const db = getSupabase();
  if (!db) return [];
  try {
    const { data, error } = await db
      .from('projects')
      .select('*')
      .order('sort_order', { ascending: true });
    if (error || !Array.isArray(data)) return [];
    return sortProjects(data.map(normalize));
  } catch {
    return [];
  }
}

type SaveResult = { ok: boolean; error?: string };

/**
 * mergeCategory — 기존 detail 에 category 만 얹은 새 객체.
 * DB 접근 없는 순수 함수(테스트 용이). 나머지 키(summary·flow·personas·tech)는 그대로 둔다.
 * detail 이 없던 행이면 category 하나만 든 객체를 만든다 — normalizeDetail 이 빈 값을 채운다.
 */
export function mergeCategory(
  detail: unknown,
  category: 'personal' | 'career',
): Record<string, unknown> {
  const base = (detail && typeof detail === 'object' && !Array.isArray(detail))
    ? detail as Record<string, unknown>
    : {};
  return { ...base, category };
}

/**
 * setProjectCategory — detail.category 만 바꾼다.
 * ⚠ upsertProject 는 detail 을 아예 보내지 않아 DB 값을 보존하는 계약이다. 그 계약을 깨지 않으려고
 * 카테고리는 이 별도 경로로 처리한다 — 기존 detail 을 읽어 category 만 얹고 그 컬럼만 UPDATE 한다.
 */
export async function setProjectCategory(
  id: string,
  category: 'personal' | 'career',
): Promise<SaveResult> {
  const db = getSupabase();
  if (!db) return { ok: false, error: 'Supabase 미연결' };
  if (!id) return { ok: false, error: 'id 필수' };
  try {
    const { data, error: readErr } = await db
      .from('projects')
      .select('detail')
      .eq('id', id)
      .maybeSingle();
    if (readErr) return { ok: false, error: readErr.message };

    const { error } = await db
      .from('projects')
      .update({ detail: mergeCategory(data?.detail, category), updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** createProject/updateProject — upsert(on conflict id). */
export async function upsertProject(p: ProjectRow): Promise<SaveResult> {
  const db = getSupabase();
  if (!db) return { ok: false, error: 'Supabase 미연결' };
  if (!p.id || !p.title) return { ok: false, error: 'id·title 필수' };
  try {
    const { error } = await db.from('projects').upsert({
      id:          p.id,
      title:       p.title,
      period:      p.period ?? '',
      role:        p.role ?? null,
      stack:       Array.isArray(p.stack) ? p.stack : [],
      description: p.description ?? '',
      highlights:  Array.isArray(p.highlights) ? p.highlights : [],
      link:        p.link ?? null,
      sort_order:  typeof p.sort_order === 'number' ? p.sort_order : 0,
      pinned:      p.pinned === true,
      updated_at:  new Date().toISOString(),
    });
    if (error) {
      // 상한 초과는 트리거가 P0001 로 거부한다 — 원문 대신 사람이 읽을 문구로 바꾼다.
      if (error.message?.includes('PINNED_LIMIT_EXCEEDED')) {
        return { ok: false, error: `상단 고정은 최대 ${PIN_MAX}개까지입니다. 다른 항목의 고정을 먼저 해제하세요.` };
      }
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function deleteProject(id: string): Promise<SaveResult> {
  const db = getSupabase();
  if (!db) return { ok: false, error: 'Supabase 미연결' };
  if (!id) return { ok: false, error: 'id 필수' };
  try {
    const { error } = await db.from('projects').delete().eq('id', id);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
