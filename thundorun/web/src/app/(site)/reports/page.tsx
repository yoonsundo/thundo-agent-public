export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { TriangleAlert, ArrowDown } from 'lucide-react';
import PipelineTree from '@/components/PipelineTree';
import BoardMeeting from '@/components/BoardMeeting';
import Empty from '@/components/state/Empty';
import {
  getLatestReport,
  getReport,
  listRecentSummaries,
  listReportDates,
  type RecentSummaryPoint,
} from '@/server/reports';
import { extractEvolution, verdictLabel, type EvolutionEntry } from '@/server/evolution';

/* ───────────────────────── 날짜 포맷 ──────────────────── */

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  }).format(d);
}

function formatDateShort(dateStr: string): string {
  const d = new Date(dateStr);
  return new Intl.DateTimeFormat('ko-KR', {
    month: 'short',
    day: 'numeric',
    weekday: 'short',
  }).format(d);
}

/* ───────────────────────── KPI 히어로 ─────────────────── */

function KpiCard({
  label,
  value,
  unit,
  sub,
  accent,
  href,
}: {
  label: string;
  value: React.ReactNode;
  /** 단위(편·건 등). 숫자 옆에 붙여 한 덩어리로 읽히게 한다(§11.4 `.stat-unit`). */
  unit?: string;
  sub?: string;
  accent?: boolean;
  /** 지정 시 카드 전체가 해당 앵커로 스크롤되는 링크가 된다(예: 자가진화 → 진화 로그 상세). */
  href?: string;
}) {
  const inner = (
    <>
      <span className="stat-label">
        {label}
        {href && (
          <span className="text-muted">
            {' '}<ArrowDown size={14} aria-hidden="true" style={{ display: 'inline', verticalAlign: 'middle' }} /> 상세
          </span>
        )}
      </span>
      <span className="stat-value" style={accent ? { color: 'var(--color-accent)' } : undefined}>
        {value}
        {unit && <span className="stat-unit">{unit}</span>}
      </span>
      {sub && <span className="card-meta">{sub}</span>}
    </>
  );
  if (href) {
    return (
      <a href={href} className="stat card-link">
        {inner}
      </a>
    );
  }
  return <div className="stat">{inner}</div>;
}

/** 최근 14일 발행 추이 — 인라인 SVG polyline (라이브러리 없음) */
function Sparkline({ points }: { points: RecentSummaryPoint[] }) {
  if (points.length < 2) return null;
  const W = 220;
  const H = 48;
  const max = Math.max(1, ...points.map((p) => p.published));
  const step = W / (points.length - 1);
  const coords = points.map(
    (p, i) => `${(i * step).toFixed(1)},${(H - 6 - (p.published / max) * (H - 12)).toFixed(1)}`,
  );
  const last = coords[coords.length - 1].split(',');

  return (
    <div className="stat stat-wide">
      <span className="stat-label">최근 {points.length}일 발행 추이</span>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ marginTop: 6, height: 48, width: '100%' }}
        preserveAspectRatio="none"
        role="img"
        aria-label="최근 발행 편수 추이"
      >
        <polyline
          points={coords.join(' ')}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle cx={last[0]} cy={last[1]} r="3" fill="var(--color-accent)" />
      </svg>
    </div>
  );
}

/* ───────────────────────── 메인 페이지 ────────────────── */

export default async function ReportsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = await searchParams;
  const dateParam =
    typeof resolvedSearchParams?.date === 'string' ? resolvedSearchParams.date : undefined;

  const [report, dates, recent] = await Promise.all([
    dateParam ? getReport(dateParam) : getLatestReport(),
    listReportDates(),
    listRecentSummaries(14),
  ]);

  /* ── 보고 없음 ── */
  if (!report) {
    return (
      <div className="container">
        <Empty title="아직 일지가 없습니다" body="에이전트들이 첫 번째 일지를 준비 중입니다." />
      </div>
    );
  }

  const { summary } = report;
  const pipeline = summary.pipeline ?? null;
  const totalAgents = report.agents.length;
  const activeCount = summary.active_agents ?? report.agents.filter((a) => a.did_work).length;
  const idleList = summary.idle_agents ?? [];

  const gateTotals = pipeline?.write.reduce(
    (acc, w) => ({ passed: acc.passed + w.gates_passed, total: acc.total + w.gates_total }),
    { passed: 0, total: 0 },
  ) ?? { passed: 0, total: 0 };

  const writerSub = summary.writers
    ? Object.entries(summary.writers)
        .filter(([, n]) => n > 0)
        .map(([w, n]) => `${w} ${n}`)
        .join(' · ')
    : '';

  // 진화 로그: 빈 항목(verdict 없는 항목이 흘러든 경우)은 렌더하지 않음
  const evolveLog = (summary.evolve ?? []).filter((e) => e && String(e).trim());
  // 자가진화 '어디서' — elephant 5W1H 레코드에서 진화 상세(어느 에이전트·어느 파일) 추출.
  // 과거 행(elephant 레코드 없음)은 [] → evolveLog(verdict 문자열)로 폴백.
  const evolution = extractEvolution(report);
  const evolveSub =
    evolution.length > 0
      ? evolution.map((e) => `${e.writer || '?'} ${verdictLabel(e.verdict)}`).join(' · ')
      : summary.audit != null
        ? `감사로그 ${summary.audit}건 해시체인`
        : undefined;

  return (
    <div className="container">

      {/* ── 페이지 헤더 ── */}
      <div className="page-head">
        <div>
          <p className="kicker">에이전트 일지 — CEO 1인·팀장 4인이 이끄는 AI 회사</p>
          <h1 className="page-title" style={{ marginTop: 'var(--space-1)' }}>
            {formatDate(report.date)}
          </h1>
        </div>

        {/* 날짜 셀렉터 */}
        {dates.length > 1 && (
          <div className="date-strip">
            {dates.slice(0, 7).map((d) => {
              const active = d === report.date;
              // 고르는 컨트롤이므로 라벨(.tag)이 아니라 §4.7 페이지 버튼을 쓴다.
              // 활성 표시는 aria-current 가 하고(키트가 스타일링), 클래스는 하나로 유지한다.
              const cls = 'page-btn';
              return (
                <Link
                  key={d}
                  href={`/reports?date=${d}`}
                  aria-current={active ? 'page' : undefined}
                  className={cls}
                >
                  {formatDateShort(d)}
                </Link>
              );
            })}
          </div>
        )}
      </div>

      {/* 섹션 사이 간격은 인라인 marginTop 이 아니라 이 스택이 책임진다.
          지표 그리드와 워킹트리 카드가 붙어 있어(간격 0px 실측) 폰에서 회색 면 하나로
          뭉쳐 보였다. 섹션 간격(24px)을 지표 그리드 내부 간격(16px)보다 크게 둬야
          "칸 사이"와 "섹션 사이"가 구분된다. */}
      <div className="stack-6">
        {/* ── KPI 히어로 + 스파크라인 (원래 설계대로 한 줄 5칸) ── */}
        <div className="grid-auto">
          <KpiCard
            label="오늘 발행"
            value={summary.published}
            unit="편"
            sub={writerSub || undefined}
            accent={summary.published > 0}
          />
          <KpiCard
            label="가동 에이전트"
            value={`${activeCount}/${totalAgents}`}
            sub={idleList.length > 0 ? `미가동: ${idleList.slice(0, 3).join('·')}${idleList.length > 3 ? '…' : ''}` : '전원 가동'}
          />
          <KpiCard
            label="통과 게이트"
            value={gateTotals.total > 0 ? `${gateTotals.passed}/${gateTotals.total}` : '—'}
            sub={gateTotals.total > 0 ? '결정론 품질 게이트' : '게이트 기록 없음'}
          />
          <KpiCard
            label="자가진화"
            value={evolveLog.length}
            unit="건"
            sub={evolveSub}
            href={evolveLog.length > 0 || evolution.length > 0 ? '#evolution-log' : undefined}
          />
          <Sparkline points={recent} />
        </div>

        {/* ── 발행 0편 경고 배너 (같은 날 별도 런으로 발행됐으면 표시 안 함) ── */}
        {pipeline?.run_status === 'zero_published' && summary.published === 0 && (
          <div className="banner" data-tone="warning">
            <TriangleAlert size={18} aria-hidden="true" />
            <span>
              오늘은 결정론 게이트가 초안을 전량 차단해 발행 0편입니다 — 품질 기준에 못 미치는 글은
              공개하지 않는 것이 이 회사의 원칙입니다.
            </span>
          </div>
        )}

        {/* ── 경영회의 — 오늘 회사가 무엇을 정했나(실행 상세보다 먼저 읽혀야 한다) ── */}
        <BoardMeeting board={summary.board} />

        {/* ── 파이프라인 워킹트리 ── */}
        <PipelineTree pipeline={pipeline} agents={report.agents} date={report.date} />

        {/* ── 진화 로그 — 어느 에이전트가 / 왜(뭐가 부족) / 어떻게 발전 / 결과(근거)까지 ── */}
        {(evolution.length > 0 || evolveLog.length > 0) && (
          <div id="evolution-log" className="card" style={{ scrollMarginTop: 80 }}>
            <p className="card-kicker">진화 로그</p>
            {evolution.length > 0 ? (
              <>
                <span className="card-meta">
                  각 항목을 클릭하면 왜 진화가 필요했는지·어떻게 발전을 시도했는지·판정 근거를 볼 수 있습니다.
                </span>
                <div className="stack-2">
                  {evolution.map((e, i) => (
                    <EvolutionRow key={i} e={e} />
                  ))}
                </div>
              </>
            ) : (
              <ul className="stack-2" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {evolveLog.map((item, i) => (
                  <li key={i} className="row" style={{ alignItems: 'flex-start' }}>
                    <span className="text-muted">›</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ───────────────────────── 진화 로그 행 ─────────────────── */

function VerdictBadge({ verdict }: { verdict: string }) {
  return (
    <span className={`tag ${verdict === 'adopt' ? 'tag-success' : 'tag-neutral'}`}>
      {verdictLabel(verdict)}
    </span>
  );
}

/** 진화 상세 지표 라인(baseline → variant score·통과율). */
function fmtScore(v: number | null | undefined): string {
  return typeof v === 'number' ? v.toFixed(1) : '—';
}
function fmtPct(v: number | null | undefined): string {
  return typeof v === 'number' ? `${Math.round(v * 100)}%` : '—';
}

function EvolutionRow({ e }: { e: EvolutionEntry }) {
  const agentName = e.writer || '알 수 없음';
  const header = (
    <>
      <VerdictBadge verdict={e.verdict} />
      <span className="card-title">
        {agentName}
        {e.version != null && <span className="text-muted"> v{e.version}</span>}
      </span>
      {e.fitness && <span className="card-meta">· {e.fitness}</span>}
    </>
  );

  // 과거 행(rich=false): 펼칠 상세가 없으므로 기존 한 줄 표기 유지
  if (!e.rich) {
    return (
      <div className="row" style={{ flexWrap: 'wrap' }}>
        {header}
        <span className="card-meta" style={{ width: '100%', wordBreak: 'break-all' }}>
          어디서: {e.where}{e.detail ? ` — ${e.detail}` : ''}
        </span>
      </div>
    );
  }

  const hasMetrics =
    e.baseScore != null || e.variantScore != null || e.basePassRate != null || e.variantPassRate != null;

  return (
    <details className="accordion">
      <summary>{header}</summary>
      <div className="accordion-body stack">
        {e.targetWeakness && (
          <div>
            <p className="kicker">왜 진화가 필요했나 · 뭐가 부족했나</p>
            <p>{e.targetWeakness}</p>
          </div>
        )}
        {e.proposal && (
          <div>
            <p className="kicker">어떻게 발전하려 했나 (제안)</p>
            <p>{e.proposal}</p>
          </div>
        )}
        {hasMetrics && (
          <div>
            <p className="kicker">판정 지표 (기존 -&gt; 변종)</p>
            <p>
              fitness {fmtScore(e.baseScore)} -&gt; {fmtScore(e.variantScore)}
              {(e.basePassRate != null || e.variantPassRate != null) && (
                <> · 게이트 통과율 {fmtPct(e.basePassRate)} -&gt; {fmtPct(e.variantPassRate)}</>
              )}
              {e.improved != null && (
                <> · 개선 {e.improved ? 'O' : 'X'}{e.noRegress != null && <> · 무회귀 {e.noRegress ? 'O' : 'X'}</>}</>
              )}
            </p>
            {e.scoring && <p className="card-meta" style={{ wordBreak: 'break-all' }}>채점식: {e.scoring}</p>}
          </div>
        )}
        {e.note && (
          <div>
            <p className="kicker">판정 근거 ({verdictLabel(e.verdict)})</p>
            <p>{e.note}</p>
          </div>
        )}
        <div>
          <p className="kicker">어디서</p>
          <p className="text-muted" style={{ wordBreak: 'break-all' }}>{e.where}{e.detail ? ` — ${e.detail}` : ''}</p>
        </div>
      </div>
    </details>
  );
}
