'use client';

/**
 * RemediationAdmin.tsx — Goose 자가 조치 승인 큐 UI (클라이언트)
 * pending 카드: 진단·계획·위험·diff 열람 + [승인]/[거절]. 처리 이력은 아래 표.
 * 승인해도 웹은 상태만 기록 — 실제 배포·재측정·롤백은 WSL executor 가 수행하고 상태를 갱신한다.
 *
 * 표현은 Modernist Kit 전용(DESIGN.md §4.9 카드 · §4.11 아코디언 · §4.13 다이얼로그 · §6 상태 3종).
 * 승인/거절 확인은 window.confirm/prompt 대신 `.dialog`(ESC 로 닫힘)로 받는다.
 */
import { useCallback, useEffect, useState } from 'react';
import ConfirmDialog from '@/app/admin/ConfirmDialog';
import Empty from '@/components/state/Empty';
import ErrorState from '@/components/state/ErrorState';
import { CardSkeleton } from '@/components/state/Skeleton';

interface Row {
  id: string;
  created_at: string;
  trigger: string;
  problem_key: string;
  diagnosis: string;
  plan: string;
  diff: string;
  risk: string;
  status: string;
  decision_by: string | null;
  decided_at: string | null;
  reject_reason: string | null;
  commit_sha: string | null;
  verification: { verdict?: string; reason?: string } | null;
  rollback_reason: string | null;
  error: string | null;
}

/**
 * 상태 → 라벨 + 태그 톤. 색 매핑은 프로젝트 공통 규칙(DESIGN.md §4.5):
 * 완료=success · 처리중=info · 대기=warning · 취소/실패=danger.
 */
const STATUS_META: Record<string, { label: string; tone: string }> = {
  pending:     { label: '승인 대기',            tone: 'tag tag-warning' },
  approved:    { label: '승인됨 (배포 대기)',   tone: 'tag tag-info' },
  rejected:    { label: '거절됨',               tone: 'tag tag-danger' },
  deploying:   { label: '배포 중',              tone: 'tag tag-info' },
  deployed:    { label: '배포됨 (재측정 대기)', tone: 'tag tag-info' },
  verified:    { label: '검증 완료',            tone: 'tag tag-success' },
  rolled_back: { label: '롤백됨',               tone: 'tag tag-danger' },
  failed:      { label: '실패',                 tone: 'tag tag-danger' },
};

function statusMeta(status: string) {
  return STATUS_META[status] ?? { label: status, tone: 'tag tag-neutral' };
}

export default function RemediationAdmin() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [msg, setMsg] = useState('');
  const [msgTone, setMsgTone] = useState<'success' | 'danger'>('success');
  /** 열려 있는 확인 다이얼로그 — 승인/거절 모두 여기로 모은다. */
  const [ask, setAsk] = useState<{ id: string; decision: 'approve' | 'reject' } | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadErr('');
    try {
      const r = await fetch('/api/admin/remediation', { cache: 'no-store' });
      if (r.ok) setRows(await r.json());
      else setLoadErr(`목록 조회 실패 (${r.status})`);
    } catch (e) {
      setLoadErr(`목록 조회 오류: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function decide(id: string, decision: 'approve' | 'reject', why?: string) {
    setBusy(id);
    try {
      const r = await fetch('/api/admin/remediation', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, decision, reason: why }),
      });
      const j = await r.json();
      setMsgTone(j.ok ? 'success' : 'danger');
      setMsg(
        j.ok
          ? decision === 'approve'
            ? '승인 완료 — executor 가 2분 내 배포를 시작합니다.'
            : '거절 처리됨.'
          : `실패: ${j.error}`,
      );
      await load();
    } catch (e) {
      setMsgTone('danger');
      setMsg(`처리 오류: ${String(e)}`);
    } finally {
      setBusy(null);
      setAsk(null);
      setReason('');
    }
  }

  const pending = rows.filter((r) => r.status === 'pending');
  const others = rows.filter((r) => r.status !== 'pending');

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">자가 조치 승인</h1>
          <p className="page-sub">
            Goose 가 발견한 사이트 문제에 대해 AI가 준비한 수정안입니다. 승인 전에는 사이트에 아무
            변경도 가해지지 않으며, 승인하면 자동으로 배포하고 재측정한 뒤 악화 시 롤백까지 진행됩니다.
          </p>
        </div>
      </div>

      <div className="stack-6">
        {msg && (
          <div className="banner" data-tone={msgTone} role="status">
            <span>{msg}</span>
          </div>
        )}

        <section>
          <div className="section-head">
            <h4>승인 대기</h4>
            <span className="text-muted">{pending.length}건</span>
          </div>

          {loadErr ? (
            <ErrorState detail={loadErr} onRetry={() => void load()} />
          ) : loading ? (
            <div className="stack"><CardSkeleton count={2} /></div>
          ) : pending.length === 0 ? (
            <Empty
              title="승인 대기 중인 제안이 없습니다"
              body="문제가 감지되면 이 화면과 Slack으로 함께 알려드립니다."
            />
          ) : (
            <div className="stack">
              {pending.map((r) => (
                <article className="card" key={r.id}>
                  <div className="row">
                    <span className={statusMeta(r.status).tone}>{statusMeta(r.status).label}</span>
                    <div className="spacer" />
                    <span className="card-meta">
                      {r.trigger} · {new Date(r.created_at).toLocaleString('ko-KR')}
                    </span>
                  </div>

                  <dl className="dl">
                    <dt>진단</dt><dd>{r.diagnosis}</dd>
                    <dt>조치</dt><dd>{r.plan}</dd>
                    <dt>위험</dt><dd>{r.risk}</dd>
                    <dt>문제 키</dt><dd className="text-mono">{r.problem_key}</dd>
                  </dl>

                  <details className="accordion">
                    <summary>{`변경 내역 보기 (${r.diff.split('\n').length}줄)`}</summary>
                    <div className="accordion-body">
                      {/* 긴 diff — 세로는 .scroll-y, 가로는 .table-scroll 로 가둔다(치수만 인라인). */}
                      <div className="table-scroll scroll-y" style={{ maxHeight: 384 }}>
                        <pre className="code">{r.diff}</pre>
                      </div>
                    </div>
                  </details>

                  <div className="row-end">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={busy === r.id}
                      onClick={() => { setReason(''); setAsk({ id: r.id, decision: 'reject' }); }}
                    >
                      거절
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy === r.id}
                      onClick={() => setAsk({ id: r.id, decision: 'approve' })}
                    >
                      {busy === r.id && <span className="spinner" />}
                      승인 후 배포
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        {others.length > 0 && (
          <section>
            <div className="section-head">
              <h4>처리 이력</h4>
              <span className="text-muted">{others.length}건</span>
            </div>
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>상태</th>
                    <th>진단</th>
                    <th>비고</th>
                    <th>일자</th>
                  </tr>
                </thead>
                <tbody>
                  {others.map((r) => (
                    <tr key={r.id}>
                      <td><span className={statusMeta(r.status).tone}>{statusMeta(r.status).label}</span></td>
                      <td>{r.diagnosis}</td>
                      <td className="text-muted">
                        {[
                          r.decision_by ? `결정: ${r.decision_by}` : '',
                          r.verification?.verdict
                            ? `검증: ${r.verification.verdict}${r.verification.reason ? ` (${r.verification.reason})` : ''}`
                            : '',
                          r.rollback_reason ? `롤백 사유: ${r.rollback_reason}` : '',
                          r.reject_reason ? `거절 사유: ${r.reject_reason}` : '',
                          r.error ? `오류: ${r.error}` : '',
                        ].filter(Boolean).join(' · ') || '—'}
                      </td>
                      <td>{new Date(r.created_at).toLocaleDateString('ko-KR')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>

      {ask?.decision === 'approve' && (
        <ConfirmDialog
          title="이 조치를 승인할까요?"
          body="승인하면 executor 가 자동으로 배포하고 재측정합니다. 결과가 나빠지면 자동 롤백됩니다."
          confirmLabel="승인 후 배포"
          tone="primary"
          busy={busy === ask.id}
          onConfirm={() => void decide(ask.id, 'approve')}
          onClose={() => setAsk(null)}
        />
      )}

      {ask?.decision === 'reject' && (
        <ConfirmDialog
          title="이 조치를 거절할까요?"
          body="거절하면 제안은 실행되지 않습니다. 사유는 이력에 남습니다(선택)."
          confirmLabel="거절"
          busy={busy === ask.id}
          onConfirm={() => void decide(ask.id, 'reject', reason.trim() || undefined)}
          onClose={() => { setAsk(null); setReason(''); }}
        >
          <div className="field">
            <label htmlFor="reject-reason">거절 사유</label>
            <textarea
              id="reject-reason"
              className="input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="예: 위험이 이득보다 큼"
            />
          </div>
        </ConfirmDialog>
      )}
    </main>
  );
}
