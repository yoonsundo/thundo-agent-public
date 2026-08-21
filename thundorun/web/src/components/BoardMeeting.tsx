import { TriangleAlert, UserRound } from 'lucide-react';
import type { BoardMeeting as BoardMeetingData, BoardRebuttalItem } from '@/server/reports';
// 🔴 `'use client'` 모듈에서 가져오면 서버 렌더 중 호출이 던진다 — lib 에서 가져온다.
import { splitHeadline } from '@/lib/board-text';

/**
 * BoardMeeting — 매일 열리는 경영회의(팀장 브리핑 → CEO 악마의 대변인 → 결정) 결과.
 *
 * 표시가 반드시 지켜야 하는 것 둘:
 *   · **결론이 확정되지 않은 회의를 확정된 것처럼 보이면 안 된다.** 반론이 형식을 못 채우면
 *     아무것도 반영되지 않는데, 그 상태를 조용히 넘기면 "아무 일도 안 일어난 날"이 정상으로 읽힌다.
 *   · **`자가발전 큐`는 `반영됨`이 아니다.** 큐 항목은 채점·회귀검사를 통과해야 실제 적용된다.
 *
 * 레이아웃 근거(디자이너 검토 2026-08-21): 처음엔 카드 하나에 팀장 4장 + 반론 5목록 + 표를
 * 전부 담았다. 그러면 `.card-kicker` 가 한 화면에 10개 나오고(위계 중복) 어디서 끊기는지 보이지
 * 않는다. 그래서 **세 블록으로 나누고**, 성격이 다른 반론 5종은 카드가 아니라 아코디언에 넣어
 * 접어 뒀다 — 카드(흰색) → 아코디언(테두리) → 카드(흰색)로 리듬도 생긴다.
 */

/**
 * 반영 상태 → 사람이 읽는 라벨.
 * 예전엔 `자가발전 큐`처럼 내부 용어를 그대로 썼다. 무슨 뜻인지 모르면 상태가 아니라 암호다.
 */
const STATUS: Record<string, { label: string; cls: string }> = {
  queued:   { label: '반영 준비됨',   cls: 'tag tag-info' },
  applied:  { label: '반영 완료',     cls: 'tag tag-success' },
  human:    { label: '내가 정해야 함', cls: 'tag tag-warning' },
  rejected: { label: '적용 안 함',    cls: 'tag tag-danger' },
  skip:     { label: '이번엔 넘어감',  cls: 'tag tag-neutral' },
  noop:     { label: '변화 없음',     cls: 'tag tag-neutral' },
  error:    { label: '처리 실패',     cls: 'tag tag-danger' },
};

function StatusTag({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, cls: 'tag tag-neutral' };
  return <span className={s.cls}>{s.label}</span>;
}

/** 저장된 형식이 문자열이든 객체든 한 모양으로 읽는다(오래된 회의 호환). */
function readItem(x: BoardRebuttalItem): { point: string; detail: string; kind?: string } {
  if (typeof x === 'string') return { point: x, detail: '' };
  return { point: x.point ?? '', detail: x.detail ?? '', kind: x.kind };
}

/** 리스크 층위 라벨 — 원문은 영어 키라 그대로 보여주면 읽는 데 방해가 된다. */
const KIND_KO: Record<string, string> = {
  technical: '기술', operational: '운영', organizational: '조직',
};

/**
 * 반론 한 묶음.
 *
 * 핵심은 **요지 한 줄이 먼저 보이고, 근거는 접혀 있다**는 것이다. 예전에는 항목마다 200~300자를
 * 통째로 뿌려서 30건이 쌓이면 읽히지 않는 벽이 됐다. 훑을 때는 굵은 한 줄만 읽고, 궁금한 것만 편다.
 * 근거가 없는 항목은 열 것이 없으므로 그냥 한 줄로 둔다.
 */
function RebuttalSection({ title, items }: { title: string; items?: BoardRebuttalItem[] }) {
  if (!items?.length) return null;
  return (
    <div>
      <p className="kicker">{title}</p>
      <ul className="list">
        {items.map((raw, i) => {
          const { point, detail, kind } = readItem(raw);
          const label = kind ? KIND_KO[kind] ?? kind : null;
          return (
            <li key={i} className="list-row">
              {detail ? (
                <details>
                  <summary>
                    {label && <span className="tag tag-neutral">{label}</span>} {point}
                  </summary>
                  <p className="card-meta">{detail}</p>
                </details>
              ) : (
                <span>
                  {label && <span className="tag tag-neutral">{label}</span>} {point}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default function BoardMeeting({ board }: { board?: BoardMeetingData }) {
  if (!board) return null;

  const r = board.rebuttal;
  const rebuttalCount = r
    ? r.hidden_assumptions.length + r.risks.length + r.logical_flaws.length
      + r.overlooked_scenarios.length + r.preventive_measures.length
    : 0;
  const queued = board.decisions.filter((d) => d.status === 'applied' || d.status === 'queued');

  return (
    <>
      {/* 섹션 제목은 카드 밖에 둔다 — "경영회의"가 아래 세 블록을 아우르는 상위 개념이라는 표시. */}
      <div className="section-head">
        <div>
          <p className="kicker">경영회의 — {board.date}</p>
          <h2 className="card-title">팀장 4인 브리핑과 CEO 반론</h2>
        </div>
      </div>

      <div className="stack-6">
        {board.held && (
          <div className="banner" data-tone="warning">
            <TriangleAlert size={18} aria-hidden="true" />
            <span>결론 미확정 — {board.held}. 이 회의는 아무것도 변경하지 않았습니다.</span>
          </div>
        )}

        {/* ① 팀장 브리핑 — 네 명은 동등한 역할이라 균일한 그리드가 맞다. */}
        <div className="card">
          <p className="card-kicker">팀장 브리핑</p>
          <div className="grid-auto">
            {board.leads.map((l) => (
              <div key={l.team} className="card-quiet">
                <p className="kicker">
                  <UserRound size={14} aria-hidden="true" /> {l.titles.join(' · ')}
                </p>
                <p className="card-title">{l.lead}</p>
                <p className="card-meta">{l.team}</p>
                {l.headline && <p>{l.headline}</p>}
                {l.gaps.length > 0 && (
                  <p className="card-meta">계측 공백 {l.gaps.length}건 — {l.gaps[0]}</p>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* ② CEO 반론 — 기본 접힘. 매일 보는 값이 아니라 파고들 때 펼치는 2차 정보다. */}
        {r && (
          <details className="accordion">
            <summary>
              <span className="card-title">CEO 악마의 대변인</span>
              <span className="card-meta">반론 {rebuttalCount}건</span>
            </summary>
            <div className="accordion-body stack">
              <RebuttalSection title="숨은 가정" items={r.hidden_assumptions} />
              <RebuttalSection title="잠재적 위험" items={r.risks} />
              <RebuttalSection title="논리적 결함" items={r.logical_flaws} />
              <RebuttalSection title="간과된 시나리오" items={r.overlooked_scenarios} />
              <RebuttalSection title="예방 조치" items={r.preventive_measures} />
            </div>
          </details>
        )}

        {/* ③ 결정과 반영 */}
        <div className="card">
          <p className="card-kicker">결정과 반영</p>
          {board.decisions.length > 0 ? (
            <div className="stack">
              {board.decisions.map((d) => {
                const s2 = STATUS[d.status] ?? { label: d.status, cls: 'tag tag-neutral' };
                return (
                  <div key={d.id} className="card-quiet">
                    <div className="row row-end">
                      <span className={s2.cls}>{s2.label}</span>
                      <span className="card-meta">{d.target ?? '—'}</span>
                    </div>
                    {/* 무엇을 하자는 것인가 — 대상 이름보다 이게 먼저다.
                        ⚠ 길이를 믿지 않는다. 502자짜리 제안이 실제로 들어온 적이 있다. */}
                    <p>{d.change ? splitHeadline(d.change, null).title : d.reason}</p>
                    {(d.rationale || d.expected_effect || d.explain?.why) && (
                      <details>
                        <summary className="card-meta">자세히</summary>
                        {d.change && splitHeadline(d.change, null).body && (
                          <p className="card-meta">{splitHeadline(d.change, null).body}</p>
                        )}
                        {d.rationale && <p className="card-meta">왜: {d.rationale}</p>}
                        {d.expected_effect && <p className="card-meta">달라지는 것: {d.expected_effect}</p>}
                        {d.explain?.why && <p className="card-meta">{d.explain.why}</p>}
                        {d.explain?.need && <p className="card-meta">{d.explain.need}</p>}
                      </details>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-muted">상정된 제안이 없습니다.</p>
          )}

          {queued.length > 0 && (
            <p className="card-meta">
              &apos;반영 준비됨&apos;은 아직 적용 전입니다 — 품질 검사를 통과해야 실제로 바뀝니다.
            </p>
          )}
          {board.needs_human.length > 0 && (
            <p className="card-meta">
              내가 정해야 할 항목 {board.needs_human.length}건 — 관리자 메뉴의 경영회의 승인함에서 읽고
              승인하거나 거부할 수 있습니다.
            </p>
          )}
        </div>
      </div>
    </>
  );
}
