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

/**
 * 경영회의(board) — blog-publisher 의 run-board.mjs 가 `summary.board` 로 실어 보낸다.
 * 새 컬럼 대신 기존 JSON 안에 넣는 이유는 DB 마이그레이션 없이 반영하기 위해서다.
 * 회의가 형식 검증에 실패하면 `held` 에 사유가 담기고 결정은 비어 있다 — 그때는
 * "아무것도 바뀌지 않았다"가 화면에 드러나야 한다.
 */
export interface BoardLead {
  team: string;
  lead: string;
  titles: string[];
  headline: string | null;
  concerns: string[];
  gaps: string[];
}
/**
 * 반론 한 건 — **요지와 근거가 나뉘어 온다.**
 * 처음엔 한 항목이 190~320자짜리 문단이었고 30건이 쌓이니 아무도 읽지 않는 목록이 됐다.
 * 화면이 요지만 먼저 보여주려면 데이터가 먼저 나뉘어 있어야 한다.
 * 오래된 회의는 문자열로 저장돼 있어 양쪽을 모두 받는다.
 */
export type BoardRebuttalItem = string | { point: string; detail?: string; kind?: string };
export interface BoardRebuttal {
  hidden_assumptions: BoardRebuttalItem[];
  risks: BoardRebuttalItem[];
  logical_flaws: BoardRebuttalItem[];
  overlooked_scenarios: BoardRebuttalItem[];
  preventive_measures: BoardRebuttalItem[];
}
export interface BoardDecision {
  id: string;
  verdict: string;
  target: string | null;
  status: string;
  reason: string;
  /**
   * 제안 원문 — 대상 이름만으로는 "무엇을 하자는 건지" 알 수 없어 사람이 판단할 수 없었다.
   * 오래된 회의에는 없으므로 전부 선택 필드다.
   */
  change?: string | null;
  /** 실행 방법 — 길 수 있다. 제목이 아니라 본문으로 읽는다. */
  plan?: string | null;
  rationale?: string | null;
  expected_effect?: string | null;
  /** 왜 자동으로 처리하지 않았는지 · 승인하면 어떻게 되는지(평문). */
  explain?: { why?: string; need?: string } | null;
}
export interface BoardMeeting {
  date: string;
  held: string | null;
  leads: BoardLead[];
  rebuttal: BoardRebuttal | null;
  decisions: BoardDecision[];
  needs_human: string[];
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
  board?: BoardMeeting;
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
