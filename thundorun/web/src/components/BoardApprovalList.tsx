'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CircleCheck, CircleX, Clock, Info } from 'lucide-react';
import type { BoardApproval } from '@/server/board-approvals';

import { splitHeadline } from '@/lib/board-text';
/**
 * BoardApprovalList — 경영회의가 "사람이 정해야 함"으로 넘긴 항목을 읽고 결정하는 화면.
 *
 * 이 화면이 존재하는 이유: 예전에는 결과 표에 "사람 승인 필요"라고만 찍히고 **승인할 곳이
 * 없었다**(2026-08-21 사용자 지적). 라벨만 있고 절차가 없으면 화면이 거짓말하는 것이다.
 *
 * 읽는 순서를 강제한다 — **무엇을 / 왜 / 승인하면 어떻게 되는지**. 대상 이름과 내부 사유만
 * 보여주던 예전 표는 비개발자가 읽어도 판단할 수 없었다.
 */

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  pending:  { text: '결정 대기', cls: 'tag tag-warning' },
  approved: { text: '승인함',   cls: 'tag tag-success' },
  rejected: { text: '거부함',   cls: 'tag tag-danger' },
  held:     { text: '보류함',   cls: 'tag tag-neutral' },
};

/**
 * 대상 유형을 사람 말로. 'agent'·'config' 는 화면에 그대로 내보내지 않는다.
 *
 * ⚠ `human_task` 는 나머지와 성격이 다르다 — 앞의 둘은 승인하면 **기계가 반영**하지만
 *    이쪽은 승인이 "할 일 확정"이고 실제 작업은 사람이 한다. 같은 '기타'로 뭉뚱그리면
 *    승인 버튼이 무엇을 하는지 오해하게 된다(코드 수정·사이트 개선이 전부 이 부류다).
 */
function targetKind(t: string | null): string {
  if (t === 'agent') return '에이전트 업무 지침';
  if (t === 'config') return '설정값';
  if (t === 'human_task') return '사람이 할 일';
  return '기타';
}


function Row({ item, onDone }: { item: BoardApproval; onDone: () => void }) {
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const decided = item.status !== 'pending';
  const headline = splitHeadline(item.change, item.plan);

  async function act(action: 'approve' | 'reject' | 'hold') {
    setError(null);
    if ((action === 'reject' || action === 'hold') && !comment.trim()) {
      setError(action === 'reject' ? '거부 사유를 적어 주세요.' : '보류 사유를 적어 주세요.');
      return;
    }
    setBusy(action);
    try {
      const res = await fetch(`/api/admin/board/${encodeURIComponent(item.key)}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, comment: comment.trim() || undefined }),
      });
      const json = await res.json();
      if (!json.ok) setError(json.error ?? '처리에 실패했습니다.');
      else onDone();
    } catch {
      setError('네트워크 오류로 처리하지 못했습니다.');
    } finally {
      setBusy(null);
    }
  }

  const status = STATUS_LABEL[item.status] ?? STATUS_LABEL.pending;

  return (
    <div className="card">
      <div className="row row-end">
        <span className={status.cls}>{status.text}</span>
        <span className="card-meta">{item.date} · {item.team ?? '팀 미상'}</span>
      </div>

      {/* ① 무엇을 하자는 것인가 — 한 줄로. 긴 실행 계획은 아래로 내린다. */}
      <h2 className="card-title">{headline.title}</h2>
      <p className="card-meta">
        {targetKind(item.target_type)} · {item.target ?? '—'}
        {typeof item.value === 'number' && ` · ${item.value} 로 변경`}
      </p>
      {headline.body && (
        <details>
          <summary className="card-meta">어떻게 바꾸는지 자세히</summary>
          <p className="card-body">{headline.body}</p>
        </details>
      )}

      {/* ② 왜·무엇이 달라지나 — 라벨과 값을 한 줄로 붙여 세로 길이를 줄인다. */}
      {(item.rationale || item.expected_effect) && (
        <dl className="dl">
          {item.rationale && (<><dt>왜</dt><dd>{item.rationale}</dd></>)}
          {item.expected_effect && (<><dt>달라지는 것</dt><dd>{item.expected_effect}</dd></>)}
        </dl>
      )}

      {/* ③ 왜 내가 정해야 하는지 — 경고가 아니라 안내다. 빨강·주황을 쓰지 않는다. */}
      {item.hold_why && (
        <p className="card-meta">
          <Info size={14} aria-hidden="true" /> {item.hold_why}
        </p>
      )}

      {decided ? (
        <p className="card-meta">
          {status.text} · {item.decided_at?.slice(0, 16).replace('T', ' ')}
          {item.decided_by && ` · ${item.decided_by}`}
          {item.comment && <> — {item.comment}</>}
          {item.applied_at && <> · 반영 완료</>}
        </p>
      ) : (
        <>
          <div className="field">
            <label htmlFor={`c-${item.key}`}>메모 — 거부하거나 나중으로 미룰 때는 이유를 적어 주세요</label>
            <input
              id={`c-${item.key}`}
              className="input"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="예: 계측 쌓인 다음에 다시 보자"
            />
          </div>
          {error && <p className="field-error">{error}</p>}
          {/* 승인만 채운 버튼으로 강조한다. 셋 다 빨강이면 무엇이 기본 동작인지 사라진다. */}
          <div className="btn-row">
            <button className="btn btn-primary" disabled={busy !== null} onClick={() => act('approve')}>
              <CircleCheck size={16} aria-hidden="true" /> {busy === 'approve' ? '처리 중…' : '승인하고 반영'}
            </button>
            <button className="btn btn-secondary" disabled={busy !== null} onClick={() => act('hold')}>
              <Clock size={16} aria-hidden="true" /> 나중에
            </button>
            <button className="btn btn-ghost" disabled={busy !== null} onClick={() => act('reject')}>
              <CircleX size={16} aria-hidden="true" /> 거부
            </button>
          </div>
          {/* 승인이 실제로 무엇을 하는지 버튼 옆에 둔다 — 누르기 전에 알아야 한다. */}
          {item.hold_need && <p className="card-meta">{item.hold_need}</p>}
        </>
      )}
    </div>
  );
}

export default function BoardApprovalList({ items }: { items: BoardApproval[] }) {
  const router = useRouter();
  const pending = items.filter((i) => i.status === 'pending');

  return (
    <div className="container">
      <div className="page-head">
        <div>
          <p className="kicker">경영회의</p>
          <h1 className="page-title">승인함</h1>
          <p className="page-sub">
            매일 아침 회의에서 자동으로 처리하지 않은 항목입니다. 읽고 결정해 주세요.
          </p>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="empty">
          <p className="empty-title">결정할 항목이 없습니다</p>
          <p className="empty-body">회의에서 사람 판단이 필요한 안건이 나오면 여기에 쌓입니다.</p>
        </div>
      ) : (
        <div className="stack-6">
          {pending.length > 0 && <p className="card-meta">결정 대기 {pending.length}건</p>}
          {items.map((item) => (
            <Row key={item.key} item={item} onDone={() => router.refresh()} />
          ))}
        </div>
      )}
    </div>
  );
}
