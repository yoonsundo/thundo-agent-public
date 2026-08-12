/**
 * evolution.ts — 자가진화(A/B 판정) 상세 추출.
 *
 * 에이전트 일지의 "자가진화 N건" KPI·진화 로그는 개수·verdict 문자열만 보여줘,
 * "어디서(어느 에이전트)·왜(뭐가 부족)·어떻게(제안)·결과(판정 근거)"를 알 수 없었다.
 * 그 정보는 daily-brief.mjs 가 elephant 레코드에 실어 보낸다:
 *   - 5W1H: where=`STEP7 → .claude/agents/<writer>.md`, what=`자가진화 판정=<verdict>`,
 *           why=`fitness a→b`, how=`채택·버전↑`|`기각·현버전 유지(단조성)`
 *   - evo(상세): target_weakness(왜/뭐가부족)·proposal(어떻게)·baseline/variant(지표)·note(근거)
 *
 * evo 가 있으면 상세를 채우고(rich=true), 없는 과거 행은 5W1H(why/how) 파싱으로 폴백(rich=false)한다.
 * 순수 함수(런타임 import 없음) — node 네이티브 strip-types 로 .mjs 스모크가 직접 import 가능하고,
 * 서버 컴포넌트(page.tsx)·클라이언트 컴포넌트(PipelineTree) 양쪽에서 공용으로 쓴다.
 */

export interface EvolutionEntry {
  /** 진화 대상 에이전트 id (beaver 등). where 파싱 실패 시 ''. */
  writer: string;
  /** 원본 where 문자열 (예: `STEP7 → .claude/agents/beaver.md`). */
  where: string;
  /** 판정 (adopt | reject | 그 외 원문). */
  verdict: string;
  /** fitness 변화 원문 (why: `fitness 15.2→14.5`). */
  fitness: string;
  /** 판정 후속 조치 원문 (how: `채택·버전↑` / `기각·현버전 유지(단조성)`). */
  detail: string;

  // ── 상세 서사(evo 있는 최신 행에만. 과거 행은 undefined) ──
  /** evo 상세를 담고 있는지(true=최신 행, false=5W1H만 있는 과거 행). */
  rich: boolean;
  /** 왜/뭐가 부족해서 진화가 필요했나. */
  targetWeakness?: string;
  /** 어떻게 발전하려 했나(제안 요약). */
  proposal?: string;
  /** 채점 방식 설명. */
  scoring?: string;
  /** 판정 근거(왜 채택/기각). */
  note?: string;
  /** 대상 버전. */
  version?: number | null;
  improved?: boolean | null;
  noRegress?: boolean | null;
  /** baseline·variant fitness score(있으면). */
  baseScore?: number | null;
  variantScore?: number | null;
  /** baseline·variant 게이트 통과율(있으면). */
  basePassRate?: number | null;
  variantPassRate?: number | null;
}

interface MetricsLike {
  score?: number | null;
  pass_rate?: number | null;
}
interface EvoLike {
  writer?: string | null;
  verdict?: string | null;
  version?: number | null;
  target_weakness?: string | null;
  proposal?: string | null;
  scoring?: string | null;
  baseline?: MetricsLike | null;
  variant?: MetricsLike | null;
  improved?: boolean | null;
  noRegress?: boolean | null;
  note?: string | null;
}
interface RecordLike {
  when?: string;
  where?: string;
  what?: string;
  why?: string;
  how?: string;
  evo?: EvoLike | null;
}
interface AgentLike {
  id?: string;
  records?: RecordLike[] | null;
}

const WRITER_RE = /\.claude\/agents\/([a-z0-9_-]+)\.md/i;
const VERDICT_RE = /자가진화\s*판정\s*=\s*([^\s·,()]+)/;

/** null/'' 를 undefined 로 정규화(빈 값은 렌더하지 않도록). */
function s(v: string | null | undefined): string | undefined {
  const t = (v ?? '').trim();
  return t ? t : undefined;
}
function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * elephant 레코드 배열에서 자가진화 판정 항목만 구조화한다.
 * what 에 `자가진화 판정=<verdict>` 가 없는 레코드(검증 베이스라인 등)는 제외 → KPI 개수와 정합.
 * evo(상세)가 있으면 rich 필드까지 채우고, 없으면 5W1H(why/how)만으로 폴백한다.
 */
export function evolutionEntries(records: RecordLike[] | null | undefined): EvolutionEntry[] {
  if (!Array.isArray(records)) return [];
  const out: EvolutionEntry[] = [];
  for (const rec of records) {
    const vm = (rec?.what ?? '').match(VERDICT_RE);
    if (!vm) continue; // 자가진화 판정 레코드만 → KPI 개수와 정합
    const where = rec?.where ?? '';
    const wm = where.match(WRITER_RE);
    const evo = rec?.evo ?? null;
    const entry: EvolutionEntry = {
      writer: wm ? wm[1] : s(evo?.writer) ?? '',
      where,
      verdict: s(evo?.verdict) ?? vm[1],
      fitness: rec?.why ?? '',
      detail: rec?.how ?? '',
      rich: false,
    };
    if (evo) {
      entry.rich = true;
      entry.targetWeakness = s(evo.target_weakness);
      entry.proposal = s(evo.proposal);
      entry.scoring = s(evo.scoring);
      entry.note = s(evo.note);
      entry.version = num(evo.version);
      entry.improved = typeof evo.improved === 'boolean' ? evo.improved : null;
      entry.noRegress = typeof evo.noRegress === 'boolean' ? evo.noRegress : null;
      entry.baseScore = num(evo.baseline?.score);
      entry.variantScore = num(evo.variant?.score);
      entry.basePassRate = num(evo.baseline?.pass_rate);
      entry.variantPassRate = num(evo.variant?.pass_rate);
    }
    out.push(entry);
  }
  return out;
}

/** 일일 보고에서 자가진화 상세를 추출한다(elephant 에이전트 레코드 경유). 없으면 []. */
export function extractEvolution(
  source: { agents?: AgentLike[] | null } | null | undefined,
): EvolutionEntry[] {
  const elephant = source?.agents?.find((a) => a?.id === 'elephant');
  return evolutionEntries(elephant?.records);
}

/** verdict 문자열을 한국어 라벨로. 미지정 verdict 은 원문 유지. */
export function verdictLabel(verdict: string): string {
  if (verdict === 'adopt') return '채택';
  if (verdict === 'reject') return '기각';
  return verdict;
}
