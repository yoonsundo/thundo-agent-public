'use client';

/**
 * PipelineTree — 에이전트 일지 워킹트리.
 * 파이프라인 7단계(수집→선정→작가→게이트→검증→발행→거버넌스)에 그날 실데이터를 오버레이하고,
 * 노드 클릭 시 5W1H + 역할별 파이프라인 디테일 + 회고를 펼친다.
 *
 * 렌더 분기 4계층:
 *  - pipeline && run_status ok/zero_published → 전체 오버레이 (게이트·검증 tri-state 포함)
 *  - pipeline && run_status legacy           → collect/publish/govern 기본 수치만, 작가·검증자는 중립
 *  - pipeline 없음 (과거 행)                  → 구조도만 (노드 클릭 5W1H는 동작)
 *  - 게이트 배지 수는 gates_total 동적 (하드코딩 금지)
 *
 * 표현은 Modernist Kit 전용(DESIGN.md §4.8 정의목록 · §4.5 상태 태그 · §4.11 아코디언).
 * 단계 흐름은 `.dl`(단계=dt / 노드=dd)로 세로 흐름을 유지한다 — 7열 그리드는 키트에 없다.
 * 마스코트 이모지는 규칙 8(이모지 금지)에 따라 제거하고 에이전트 id·`.avatar` 이니셜로 표기한다.
 */

import Link from 'next/link';
import { Fragment, useState } from 'react';
import { Check, X } from 'lucide-react';
import type { PipelineSummary, ReportAgent } from '@/server/reports';
import { evolutionEntries, verdictLabel } from '@/server/evolution';

const STAGES: { key: string; label: string; ids: string[] }[] = [
  { key: 'collect', label: '수집', ids: ['cheetah', 'owl', 'magpie'] },
  { key: 'select', label: '주제 선정', ids: [] },
  { key: 'write', label: '작가', ids: ['beaver', 'fox', 'wolf'] },
  { key: 'gate', label: '게이트', ids: [] },
  { key: 'validate', label: '검증', ids: ['eagle', 'bee', 'swan', 'raven', 'peacock'] },
  { key: 'publish', label: '발행', ids: ['penguin'] },
  { key: 'govern', label: '거버넌스', ids: ['elephant', 'crane', 'meerkat'] },
];

const VALIDATOR_LABEL: Record<string, string> = {
  pass: '통과', blocked: '차단', unreached: '미도달',
};

/** 에이전트 id → 아바타 이니셜(이모지 대체). */
function initials(id: string): string {
  return id.slice(0, 2).toUpperCase();
}

/**
 * 데이터로 흘러든 기하문자·이모지를 **렌더 직전에** 평문화한다 (규칙 8 / §12.8).
 *
 * 이 화면의 본문은 에이전트가 쓴 문자열이고, `server/evolution.ts` 는 화살표를 데이터로 담는다
 * (`where`=`STEP7 → .claude/agents/beaver.md`, `why`=`fitness 15.2→14.5`). 소스 가드는
 * `server/**` 를 안 보지만 E2E 는 렌더된 DOM 을 보기 때문에, 데이터는 건드리지 않고 표시만 바꾼다.
 *   - 화살표(→ ⇒ ← ↔ ↳)는 의미가 있으므로 ASCII 로 치환한다(지우면 `15.214.5` 가 된다).
 *   - 나머지 픽토그램은 제거한다(한국어 산문의 의미를 바꾸지 않는다).
 */
const BANNED_GLYPH = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2190}-\u{2BFF}\u{2600}-\u{27BF}]/gu;

/** 치환표는 소스 가드에도 걸리지 않게 코드포인트로만 적는다. */
const GLYPH_TEXT: Array<[RegExp, string]> = [
  [/[\u2194\u21D4]/g, '<->'],                    // 양방향 (좌우 단독보다 먼저 치환)
  [/[\u2192\u21D2\u21A6\u2794\u27A1]/g, '->'], // 오른쪽 화살표류
  [/[\u2190\u21D0]/g, '<-'],                     // 왼쪽
  [/[\u21B3\u21AA]/g, '>'],                      // 하위 항목 표시
];

function plain(s: string | null | undefined): string {
  if (s == null) return '';
  let out = s;
  for (const [re, text] of GLYPH_TEXT) out = out.replace(re, text);
  return out.replace(BANNED_GLYPH, '').replace(/[ \t]{2,}/g, ' ').trim();
}

interface Props {
  pipeline: PipelineSummary | null;
  agents: ReportAgent[];
  date: string;
}

export default function PipelineTree({ pipeline, agents, date }: Props) {
  const [selected, setSelected] = useState<string | null>(null);

  const agentMap = new Map(agents.map((a) => [a.id, a]));
  // 오버레이 레벨: full(현행 스키마) / basic(legacy — 집계 수치만) / none(pipeline 없음)
  const overlay: 'full' | 'basic' | 'none' = !pipeline
    ? 'none'
    : pipeline.run_status === 'legacy' || pipeline.run_status === 'no_run'
      ? 'basic'
      : 'full';

  const gateTotals = pipeline?.write.reduce(
    (acc, w) => ({ passed: acc.passed + w.gates_passed, total: acc.total + w.gates_total }),
    { passed: 0, total: 0 },
  ) ?? { passed: 0, total: 0 };
  const gateFailed = [...new Set(pipeline?.write.flatMap((w) => w.gates_failed) ?? [])];

  const toggle = (id: string) => setSelected((cur) => (cur === id ? null : id));

  return (
    <div className="card stack">
      {/* lion 지휘바 */}
      <button
        type="button"
        className="btn btn-block btn-row btn-secondary"
        aria-expanded={selected === 'lion'}
        onClick={() => toggle('lion')}
      >
        <span className="avatar avatar-neutral">{initials('lion')}</span>
        lion
        <span className="text-muted">오케스트레이터 — 일일 런 전체 조율·자가치유</span>
        <span className="spacer" />
        {overlay === 'full' && pipeline && (
          /* 런이 정상이 아니고 발행도 0이면 실패다 — §4.5 는 실패를 danger 로 고정한다. */
          <span className={pipeline.run_status === 'ok' || pipeline.publish.count > 0 ? 'tag tag-success' : 'tag tag-danger'}>
            {pipeline.publish.count > 0
              ? `발행 ${pipeline.publish.count}편`
              : pipeline.run_status === 'ok'
                ? '런 완료'
                : '발행 0편'}
          </span>
        )}
      </button>

      <p className="kicker">전 단계 지휘</p>

      {/* 7단계 흐름 — 단계(dt) → 노드(dd) */}
      <dl className="dl">
        {STAGES.map((stage) => (
          <Fragment key={stage.key}>
            <dt>{stage.label}</dt>
            <dd>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                {/* 수집 요약 */}
                {stage.key === 'collect' && overlay !== 'none' && pipeline && (
                  <span className="tag tag-neutral">
                    원소재 {pipeline.collect.raw} · 주제풀 {pipeline.collect.pool}
                  </span>
                )}

                {/* 주제 선정 노드 (에이전트 아님) */}
                {stage.key === 'select' && (
                  <span className="tag tag-neutral">
                    주제 {overlay === 'full' && pipeline?.select.topics != null ? `${pipeline.select.topics}건` : '—'}
                  </span>
                )}

                {/* 게이트 노드 (에이전트 아님) — 게이트 수 동적 */}
                {stage.key === 'gate' && (
                  overlay === 'full' && gateTotals.total > 0 ? (
                    <>
                      <span className={gateFailed.length > 0 ? 'tag tag-danger' : 'tag tag-success'}>
                        결정론 게이트 {gateTotals.passed}/{gateTotals.total}
                      </span>
                      {gateFailed.length > 0 && (
                        <span className="text-muted">차단: {gateFailed.join(' · ')}</span>
                      )}
                    </>
                  ) : (
                    <span className="tag tag-neutral">결정론 게이트 —</span>
                  )
                )}

                {/* 에이전트 노드들 */}
                {stage.ids.map((id) => {
                  const agent = agentMap.get(id);
                  const badge = nodeBadge(id, stage.key, pipeline, overlay, agent);
                  return (
                    <button
                      key={id}
                      type="button"
                      className="btn btn-secondary btn-sm"
                      aria-expanded={selected === id}
                      onClick={() => toggle(id)}
                    >
                      {id}
                      {badge.text && <span className={badge.cls}>{badge.text}</span>}
                    </button>
                  );
                })}
              </div>

              {/* 선정 주제 제목 */}
              {stage.key === 'select' && overlay === 'full' && pipeline?.select.titles && pipeline.select.titles.length > 0 && (
                <ul>
                  {pipeline.select.titles.map((t) => (
                    <li key={t}>{plain(t)}</li>
                  ))}
                </ul>
              )}
            </dd>
          </Fragment>
        ))}
      </dl>

      {/* 노드 클릭 → 상세 패널 */}
      {selected && agentMap.get(selected) && (
        <NodeDetail
          agent={agentMap.get(selected)!}
          pipeline={pipeline}
          overlay={overlay}
          date={date}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

/* ── 노드 배지 (역할별) ── */
function nodeBadge(
  id: string,
  stageKey: string,
  pipeline: PipelineSummary | null,
  overlay: 'full' | 'basic' | 'none',
  agent?: ReportAgent,
): { text: string | null; cls: string; tone: 'ok' | 'warn' | 'idle' | 'neutral' } {
  const idle = { text: '휴무', cls: 'tag tag-neutral', tone: 'idle' as const };
  const activeDot = { text: '가동', cls: 'tag tag-accent', tone: 'ok' as const };
  if (!agent?.did_work && stageKey !== 'validate') return agent?.did_work === false ? idle : { text: null, cls: '', tone: 'neutral' };

  if (overlay === 'full' && pipeline) {
    if (stageKey === 'write') {
      const w = pipeline.write.find((x) => x.writer === id);
      if (w) {
        const allPass = w.gates_failed.length === 0;
        // 게이트 미통과는 차단(blocked)과 같은 실패 계열 — danger 로 통일(§4.5).
        return {
          text: `${w.gates_passed}/${w.gates_total}`,
          cls: allPass ? 'tag tag-success' : 'tag tag-danger',
          tone: allPass ? 'ok' : 'warn',
        };
      }
    }
    if (stageKey === 'validate') {
      const v = pipeline.validate.find((x) => x.validator === id);
      if (v) {
        if (v.state === 'pass') return { text: '통과', cls: 'tag tag-success', tone: 'ok' };
        if (v.state === 'blocked') return { text: '차단', cls: 'tag tag-danger', tone: 'warn' };
        return { text: '미도달', cls: 'tag tag-neutral', tone: 'idle' };
      }
    }
    if (id === 'penguin') {
      return pipeline.publish.count > 0
        ? { text: `${pipeline.publish.count}편`, cls: 'tag tag-success', tone: 'ok' }
        : { text: '0편', cls: 'tag tag-neutral', tone: 'idle' };
    }
    if (id === 'elephant' && pipeline.govern.evolve.length > 0) {
      return { text: `진화 ${pipeline.govern.evolve.length}`, cls: 'tag tag-accent', tone: 'ok' };
    }
  }
  if (overlay === 'basic' && pipeline && id === 'penguin') {
    return { text: `${pipeline.publish.count}편`, cls: 'tag tag-accent', tone: 'ok' };
  }
  return agent?.did_work ? activeDot : idle;
}

/* ── 상세 패널: 5W1H + 역할별 파이프라인 디테일 + 회고 ── */
const LABEL_KO = { when: '언제', where: '어디서', what: '무엇을', why: '왜', how: '어떻게' } as const;

function NodeDetail({
  agent,
  pipeline,
  overlay,
  date,
  onClose,
}: {
  agent: ReportAgent;
  pipeline: PipelineSummary | null;
  overlay: 'full' | 'basic' | 'none';
  date: string;
  onClose: () => void;
}) {
  const detail = overlay === 'full' && pipeline ? roleDetail(agent.id, pipeline, agent) : null;

  return (
    <div className="card card-outline stack">
      <div className="row">
        <span className="avatar avatar-neutral">{initials(agent.id)}</span>
        <div>
          <div>
            <b>{agent.id}</b> <span className="text-muted">— {plain(agent.desc)}</span>
          </div>
          <div className="card-meta">{date}</div>
        </div>
        <div className="spacer" />
        <button type="button" className="btn btn-icon" onClick={onClose} aria-label="상세 닫기">
          <X size={20} aria-hidden />
        </button>
      </div>

      <div className={detail ? 'grid-2' : 'stack'}>
        {/* 5W1H 기록 */}
        <div>
          <p className="kicker">오늘 한 일 (5W1H)</p>
          {agent.records.length === 0 ? (
            <p className="text-muted">오늘 기록된 작업이 없습니다.</p>
          ) : (
            <div className="stack">
              {agent.records.map((rec, i) => (
                <dl className="dl" key={i}>
                  {(['when', 'where', 'what', 'why', 'how'] as const)
                    .filter((k) => rec[k])
                    .map((k) => (
                      <Fragment key={k}>
                        <dt>{LABEL_KO[k]}</dt>
                        <dd>{plain(rec[k])}</dd>
                      </Fragment>
                    ))}
                </dl>
              ))}
            </div>
          )}
        </div>

        {/* 역할별 파이프라인 디테일 */}
        {detail && (
          <div>
            <p className="kicker">파이프라인 디테일</p>
            {detail}
          </div>
        )}
      </div>

      {/* 회고 */}
      {agent.reflection && (
        <>
          <hr className="hr" />
          <p className="kicker">회고 (에이전트가 직접 작성)</p>
          {agent.reflection.결과요약 && <p>{plain(agent.reflection.결과요약)}</p>}
          <dl className="dl">
            {([
              ['느낀점', '느낀점'],
              ['어려웠던 점', '어려웠던점'],
              ['막힌 부분', '막힌부분'],
              ['보완한 점', '보완한점'],
              ['발전할 부분', '발전할부분'],
            ] as const).map(([label, key]) =>
              agent.reflection?.[key] ? (
                <Fragment key={key}>
                  <dt>{label}</dt>
                  <dd>{plain(agent.reflection[key])}</dd>
                </Fragment>
              ) : null,
            )}
          </dl>
        </>
      )}
    </div>
  );
}

/* 검증자별 담당 영역 + 판정 근거 (peacock 만 통과로 보이는 이유 설명) */
const VALIDATOR_ROLE: Record<string, { checks: string; basis: 'gate' | 'review' }> = {
  eagle: { checks: '사실·수치·출처 정합성', basis: 'review' },
  bee: { checks: '키워드·구조·메타 SEO', basis: 'review' },
  swan: { checks: '가독성·흐름·문장 완성도', basis: 'review' },
  raven: { checks: '독창성·표절·진부 표현', basis: 'review' },
  peacock: { checks: '홈 렌더·형태 적합성', basis: 'gate' },
};

/* 역할별 파이프라인 디테일 콘텐츠 (full 오버레이일 때만) */
function roleDetail(id: string, p: PipelineSummary, agent?: ReportAgent): React.ReactNode | null {
  // lion — 오늘 런 전체 개요
  if (id === 'lion') {
    const statusKo =
      p.run_status === 'ok' ? '정상 완주'
        : p.run_status === 'zero_published' ? '완주(게이트 전량 차단으로 발행 0)'
        : p.run_status === 'legacy' || p.run_status === 'no_run' ? '집계 수치만'
        : String(p.run_status);
    return (
      <dl className="dl">
        <dt>수집·풀</dt>
        <dd>원소재 {p.collect.raw}건에서 주제풀 {p.collect.pool}건</dd>
        <dt>주제 선정</dt>
        <dd>{p.select.topics ?? '—'}건</dd>
        <dt>작가 초안</dt>
        <dd>{p.write.length}편</dd>
        <dt>발행</dt>
        <dd>{p.publish.count}편</dd>
        <dt>런 상태</dt>
        <dd>{statusKo}</dd>
      </dl>
    );
  }

  // 수집 3마리 — 실제 수집물·풀 기여·선정 주제 (역할 차별화: magpie=원소재, cheetah=트렌드 각도, owl=심층 근거)
  if (['cheetah', 'owl', 'magpie'].includes(id)) {
    const samples = p.collect.samples ?? [];
    const poolTopics = p.collect.pool_topics ?? [];
    const titles = p.select.titles ?? [];
    const roleNote: Record<string, string> = {
      magpie: 'Reddit·HN 공개 피드에서 니치 원소재를 실수집',
      cheetah: '수집 원소재에서 지금 주목할 트렌드 각도를 선별해 주제풀에 기여',
      owl: '선정 주제에 심층 근거·출처를 보강해 작가 집필 근거 제공',
    };
    return (
      <div className="stack">
        <p className="text-muted">{roleNote[id]}</p>
        {id === 'magpie' && samples.length > 0 && (
          <div>
            <p className="kicker">오늘 수집한 원소재 ({p.collect.raw}건 중 상위)</p>
            <ul>
              {samples.map((s) => (
                <li key={s}>{plain(s)}</li>
              ))}
              {p.collect.raw > samples.length && (
                <li className="text-muted">외 {p.collect.raw - samples.length}건</li>
              )}
            </ul>
          </div>
        )}
        {poolTopics.length > 0 && (
          <div>
            <p className="kicker">주제 풀 기여 ({p.collect.pool}건)</p>
            <ul>
              {poolTopics.map((t) => (
                <li key={t}>{plain(t)}</li>
              ))}
            </ul>
          </div>
        )}
        {titles.length > 0 && (
          <div>
            <p className="kicker">오늘 선정 주제</p>
            <ul>
              {titles.map((t) => (
                <li key={t}>
                  <Check size={11} aria-hidden /> {plain(t)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  // 작가 — 글 제목·시도·게이트 내역·발행 여부
  if (['beaver', 'fox', 'wolf'].includes(id)) {
    const entries = p.write.filter((w) => w.writer === id);
    if (entries.length === 0) return null;
    return (
      <div className="stack">
        {entries.map((w, i) => (
          <dl className="dl" key={i}>
            <dt>작성 글</dt>
            <dd>{plain(w.title)}</dd>
            <dt>시도</dt>
            <dd>{w.attempts}회</dd>
            <dt>게이트</dt>
            <dd>
              <span className={w.gates_failed.length === 0 ? 'tag tag-success' : 'tag tag-danger'}>
                {w.gates_passed}/{w.gates_total}
              </span>
              {w.gates_failed.length > 0 && (
                <span className="text-muted"> 차단: {plain(w.gates_failed.join(' · '))}</span>
              )}
            </dd>
            <dt>결과</dt>
            <dd>
              {w.published
                ? <span className="tag tag-success">발행됨</span>
                : <span className="tag tag-neutral">미발행</span>}
            </dd>
          </dl>
        ))}
      </div>
    );
  }

  // 검증자 — 담당 영역 + 판정 + 판정 근거(peacock=게이트 파생 / 나머지=LLM 리뷰)
  if (['eagle', 'bee', 'swan', 'raven', 'peacock'].includes(id)) {
    const v = p.validate.find((x) => x.validator === id);
    if (!v) return null;
    const role = VALIDATOR_ROLE[id];
    return (
      <div className="stack">
        <dl className="dl">
          <dt>담당</dt>
          <dd>{role.checks}</dd>
          <dt>판정</dt>
          <dd>
            <span
              className={
                v.state === 'pass'
                  ? 'tag tag-success'
                  : v.state === 'blocked'
                    ? 'tag tag-danger'
                    : 'tag tag-neutral'
              }
            >
              {VALIDATOR_LABEL[v.state]}
            </span>
          </dd>
          <dt>근거</dt>
          <dd>
            {role.basis === 'gate'
              ? 'render-fit 결정론 게이트에서 파생 — 게이트는 모든 초안에 실행되므로, 뒤 게이트가 차단돼도 형태 판정은 남습니다.'
              : '초안이 결정론 게이트를 전부 통과해 검증 단계(STEP 5)까지 도달해야 LLM 리뷰로 판정합니다.'}
          </dd>
        </dl>
        {v.state === 'unreached' && (
          <div className="banner" data-tone="warning">
            <span>오늘은 게이트가 초안을 앞단에서 차단해 이 검증자까지 도달한 초안이 없어 <b>미도달</b>입니다.</span>
          </div>
        )}
      </div>
    );
  }

  // penguin — 발행 슬러그 링크
  if (id === 'penguin') {
    if (p.publish.slugs.length === 0) {
      return <p className="text-muted">오늘 발행된 글이 없습니다.</p>;
    }
    return (
      <div>
        <p className="kicker">오늘 발행한 글 ({p.publish.count}편)</p>
        <ul>
          {p.publish.slugs.map((slug) => (
            <li key={slug}>
              <Link href={`/blog/${slug}`}>{slug}</Link>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  // elephant — 진화 verdict + 어디서(어느 에이전트·파일) + 감사
  if (id === 'elephant') {
    const evo = evolutionEntries(agent?.records);
    return (
      <div className="stack">
        <dl className="dl">
          <dt>진화</dt>
          <dd>
            {evo.length > 0
              ? `${evo.length}건 판정`
              : p.govern.evolve.length > 0
                ? plain(p.govern.evolve.join(' · '))
                : '오늘 채택/기각 판정 없음'}
          </dd>
          <dt>감사로그</dt>
          <dd>{p.govern.audit}건 (append-only 해시체인)</dd>
        </dl>
        {evo.length > 0 && (
          <div className="list">
            {evo.map((e, i) => {
              const head = (
                <>
                  <span className={e.verdict === 'adopt' ? 'tag tag-success' : 'tag tag-neutral'}>
                    {plain(verdictLabel(e.verdict))}
                  </span>
                  <span>{plain(e.writer) || '알 수 없음'}</span>
                  {e.fitness && <span className="text-muted">({plain(e.fitness)})</span>}
                </>
              );
              // 상세(evo)가 있으면 왜/뭐가부족·근거를 아코디언으로, 없으면 기존 한 줄 유지
              if (e.rich && (e.targetWeakness || e.note)) {
                return (
                  <details className="accordion" key={i}>
                    <summary>{head}</summary>
                    <div className="accordion-body stack-2">
                      {e.targetWeakness && <p><b>왜:</b> {plain(e.targetWeakness)}</p>}
                      {e.proposal && <p><b>제안:</b> {plain(e.proposal)}</p>}
                      {e.note && <p><b>근거:</b> {plain(e.note)}</p>}
                      <p className="card-meta">{plain(e.where)}</p>
                    </div>
                  </details>
                );
              }
              return (
                <div className="list-row" key={i}>
                  {head}
                  <div className="spacer" />
                  <span className="card-meta">{plain(e.where)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // crane — 건강검진, meerkat — 관제탑(위키 감사): 역할 요약 + 오늘 활동 건수
  if (id === 'crane' || id === 'meerkat') {
    const note =
      id === 'crane'
        ? '일하는 에이전트의 이상 징후를 감지·진단하고 수리안을 제안합니다(적용은 lion). 감시장치 자가수정은 금지.'
        : '방법론 위키를 운영하고 전체 에이전트의 방법론 준수를 주기 감사합니다(read-only·제안 전용).';
    const count = agent?.records.length ?? 0;
    return (
      <div className="stack-2">
        <p className="text-muted">{note}</p>
        <p>
          오늘 활동: <b>{count}건</b>
          {count === 0 && <span className="text-muted"> — 특이사항 없음</span>}
        </p>
      </div>
    );
  }

  return null;
}
