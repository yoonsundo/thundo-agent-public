/**
 * reports.ts — 에이전트 일일 업무보고(agent_reports) 서버 조회.
 * blog-publisher 의 daily-brief.mjs 가 날짜당 1행 upsert. 사이트는 service_role 로 읽어 렌더.
 */
import { getSupabase } from '@/lib/supabase';

/** A/B 채점 지표(baseline·variant). evolve-history.jsonl 원본 스키마 그대로. */
export interface EvolutionMetrics {
  score?: number | null;
  pass_rate?: number | null;
  avg_density?: number | null;
  avg_niche?: number | null;
  n?: number | null;
}

/**
 * 자가진화 상세 서사 — daily-brief.mjs 가 evolve-history.jsonl 에서 그대로 실어 보낸다.
 * 왜/뭐가 부족(target_weakness) · 어떻게 발전 시도(proposal) · 판정 지표(baseline/variant) · 근거(note).
 * 과거 행(이 필드 부재)은 evolution.ts 가 5W1H(why/how) 파싱으로 폴백.
 */
export interface EvolutionDetail {
  writer?: string | null;
  verdict?: string | null;
  version?: number | null;
  target_weakness?: string | null;
  proposal?: string | null;
  scoring?: string | null;
  baseline?: EvolutionMetrics | null;
  variant?: EvolutionMetrics | null;
  improved?: boolean | null;
  noRegress?: boolean | null;
  note?: string | null;
}

export interface AgentRecord {
  when: string;
  where: string;
  what: string;
  why: string;
  how: string;
  /** 자가진화 판정 레코드에만 존재(옵셔널). elephant 진화 레코드가 실어 보내는 상세. */
  evo?: EvolutionDetail | null;
}

export interface AgentReflection {
  결과요약?: string;
  느낀점?: string;
  어려웠던점?: string;
  막힌부분?: string;
  보완한점?: string;
  발전할부분?: string;
}

export interface ReportAgent {
  id: string;
  role: string;
  desc: string;
  did_work: boolean;
  records: AgentRecord[];
  reflection?: AgentReflection | null;
}

/** 파이프라인 워킹트리 오버레이 수치 — daily-brief.mjs buildPipeline() 산출. 과거 행에는 없음(옵셔널). */
export interface PipelineWrite {
  writer: string;
  title: string;
  attempts: number;
  gates_passed: number;
  gates_total: number;
  gates_failed: string[];
  published: boolean;
}

export type ValidatorState = 'pass' | 'blocked' | 'unreached';

export interface PipelineValidate {
  validator: string;
  state: ValidatorState;
}

export interface PipelineSummary {
  collect: { raw: number; pool: number; samples?: string[]; pool_topics?: string[] };
  select: { topics: number | null; titles?: string[] };
  write: PipelineWrite[];
  validate: PipelineValidate[];
  publish: { count: number; slugs: string[] };
  govern: { evolve: string[]; audit: number };
  run_status: 'ok' | 'zero_published' | 'legacy' | 'no_run' | string;
}

export interface ReportSummary {
  published: number;
  cron: boolean;
  writers: Record<string, number>;
  evolve: string[];
  images: number;
  active_agents: number;
  idle_agents: string[];
  audit?: number;
  pipeline?: PipelineSummary;
}

export interface AgentReport {
  date: string;
  summary: ReportSummary;
  agents: ReportAgent[];
}

/** 가장 최근 보고 1건. */
export async function getLatestReport(): Promise<AgentReport | null> {
  const db = getSupabase();
  if (!db) return null;
  const { data, error } = await db
    .from('agent_reports')
    .select('date, summary, agents')
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data as AgentReport;
}

/** 특정 날짜 보고. */
export async function getReport(date: string): Promise<AgentReport | null> {
  const db = getSupabase();
  if (!db) return null;
  const { data, error } = await db
    .from('agent_reports')
    .select('date, summary, agents')
    .eq('date', date)
    .maybeSingle();
  if (error || !data) return null;
  return data as AgentReport;
}

export interface RecentSummaryPoint {
  date: string;
  published: number;
  active: number;
}

/** 최근 N일 발행·가동 추이(스파크라인용) — JSONB 필드만 프로젝션해 행 전체를 당기지 않음. */
export async function listRecentSummaries(days = 14): Promise<RecentSummaryPoint[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from('agent_reports')
    .select('date, published:summary->published, active:summary->active_agents')
    .order('date', { ascending: false })
    .limit(days);
  if (error || !data) return [];
  return (data as Array<{ date: string; published: unknown; active: unknown }>)
    .map((r) => ({ date: String(r.date), published: Number(r.published) || 0, active: Number(r.active) || 0 }))
    .reverse();
}

/** 보고 날짜 목록(최신순, 최근 30). */
export async function listReportDates(): Promise<string[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from('agent_reports')
    .select('date')
    .order('date', { ascending: false })
    .limit(30);
  if (error || !data) return [];
  return data.map((r) => String(r.date));
}
