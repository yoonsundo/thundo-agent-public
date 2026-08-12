'use client';

/**
 * NoticesAdminList.tsx — 공지 관리 목록 (클라이언트)
 * 목록 조회 + 고정 토글 + 삭제. 작성·수정은 /admin/notices/new, /admin/notices/[id]/edit 로 이동.
 *
 * 표현은 Modernist Kit 전용(DESIGN.md §4.7 테이블·툴바 · §4.13 다이얼로그 · §6 상태 3종).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Pencil, Pin, PinOff, Plus, Trash2 } from 'lucide-react';
import ConfirmDialog from '@/app/admin/ConfirmDialog';
import Empty from '@/components/state/Empty';
import ErrorState from '@/components/state/ErrorState';
import { TableSkeleton } from '@/components/state/Skeleton';

/** 고정 가능한 공지 최대 개수 — 서버 트리거와 같은 값. */
const PIN_MAX = 5;

interface NoticeRow {
  id:         string;
  title:      string;
  body:       string;
  pinned:     boolean;
  pinned_at:  string | null;
  author:     string | null;
  created_at: string;
  updated_at: string;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ko-KR');
}

type SortKey = 'title' | 'created_at' | 'updated_at';

export default function NoticesAdminList() {
  const [rows, setRows]       = useState<NoticeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [pinBusy, setPinBusy] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [msg, setMsg]         = useState('');
  /** 작업 결과 톤 — 다른 어드민 화면(AgentsAdmin·ProjectsAdmin·RemediationAdmin)과 같은 방식(§4.5). */
  const [msgTone, setMsgTone] = useState<'success' | 'danger'>('success');
  const [confirmRow, setConfirmRow] = useState<NoticeRow | null>(null);
  const [removing, setRemoving] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadErr('');
    try {
      const res = await fetch('/api/admin/notices', { cache: 'no-store' });
      if (res.ok) setRows(await res.json());
      else setLoadErr(`목록 조회 실패 (${res.status})`);
    } catch (e) {
      setLoadErr(`목록 조회 오류: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const pinnedRows = rows.filter((r) => r.pinned);
  const pinnedCount = pinnedRows.length;

  async function togglePin(id: string, next: boolean) {
    setPinBusy(id);
    setMsg('');
    try {
      const res = await fetch(`/api/admin/notices/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pinned: next }),
      });
      const j = await res.json();
      if (res.ok && j.ok) {
        setMsgTone('success');
        setMsg(next ? '공지를 고정했습니다.' : '공지 고정을 해제했습니다.');
        await load();
      } else if (res.status === 409) {
        const titles = pinnedRows.map((r) => r.title).join(', ');
        setMsgTone('danger');
        setMsg(`고정은 최대 ${PIN_MAX}개까지입니다. 먼저 다음 공지의 고정을 해제하세요: ${titles}`);
      } else {
        setMsgTone('danger');
        setMsg(`실패: ${j.error ?? res.status}`);
      }
    } catch (e) {
      setMsgTone('danger');
      setMsg(`처리 오류: ${String(e)}`);
    } finally {
      setPinBusy(null);
    }
  }

  async function remove(id: string) {
    setRemoving(true);
    setMsg('');
    try {
      const res = await fetch(`/api/admin/notices/${id}`, { method: 'DELETE' });
      const j = await res.json();
      if (res.ok && j.ok) {
        setMsgTone('success');
        setMsg('공지를 삭제했습니다.');
        await load();
      } else {
        setMsgTone('danger');
        setMsg(`삭제 실패: ${j.error ?? res.status}`);
      }
    } catch (e) {
      setMsgTone('danger');
      setMsg(`삭제 오류: ${String(e)}`);
    } finally {
      setRemoving(false);
      setConfirmRow(null);
    }
  }

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const out = [...rows].sort((a, b) =>
      sort.key === 'title'
        ? a.title.localeCompare(b.title, 'ko')
        : a[sort.key].localeCompare(b[sort.key]),
    );
    return sort.dir === 'desc' ? out.reverse() : out;
  }, [rows, sort]);

  const ariaSort = (key: SortKey) =>
    sort?.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
  const toggleSort = (key: SortKey) =>
    setSort((cur) => (cur?.key === key ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  // 빈 상태가 뜨면 그 화면의 유일한 primary 는 빈 상태의 액션이다(§4.4·§4.14) —
  // 같은 '새 공지' 가 머리글에도 있으므로 이때는 머리글 쪽을 secondary 로 내린다.
  const isEmpty = !loadErr && !loading && rows.length === 0;

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">공지 관리</h1>
          <p className="page-sub">공개 공지사항을 등록·수정·고정·삭제합니다.</p>
        </div>
        <div className="page-actions">
          <Link
            className={isEmpty ? 'btn btn-secondary' : 'btn btn-primary'}
            href="/admin/notices/new"
          >
            <Plus size={16} aria-hidden />
            새 공지
          </Link>
        </div>
      </div>

      <div className="toolbar">
        <span className={pinnedCount >= PIN_MAX ? 'tag tag-warning' : 'tag tag-neutral'}>
          고정 {pinnedCount}/{PIN_MAX}
        </span>
        <div className="spacer" />
        <span className="text-muted">전체 {rows.length}건</span>
      </div>

      {msg && (
        <div className="banner" data-tone={msgTone} role={msgTone === 'danger' ? 'alert' : 'status'}>
          <span>{msg}</span>
        </div>
      )}

      {loadErr ? (
        <ErrorState detail={loadErr} onRetry={() => void load()} />
      ) : !loading && rows.length === 0 ? (
        <Empty
          title="등록된 공지가 없습니다"
          body="첫 공지를 작성하면 공개 공지사항 목록과 홈 배너에 노출됩니다."
          action={
            <Link className="btn btn-primary" href="/admin/notices/new">
              <Plus size={16} aria-hidden />
              새 공지 작성
            </Link>
          }
        />
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 72 }}>고정</th>
                <th aria-sort={ariaSort('title')} onClick={() => toggleSort('title')}>제목</th>
                <th aria-sort={ariaSort('created_at')} onClick={() => toggleSort('created_at')}>작성</th>
                <th aria-sort={ariaSort('updated_at')} onClick={() => toggleSort('updated_at')}>수정</th>
                <th />
              </tr>
            </thead>
            {loading ? (
              <TableSkeleton cols={5} />
            ) : (
              <tbody>
                {sorted.map((r) => (
                  <tr key={r.id} data-selected={r.pinned}>
                    <td>
                      {r.pinned
                        ? <span className="tag tag-accent">고정</span>
                        : <span className="text-muted">—</span>}
                    </td>
                    <td>{r.title}</td>
                    <td>{fmtDate(r.created_at)}</td>
                    <td>{fmtDate(r.updated_at)}</td>
                    <td className="num">
                      <Link className="btn btn-ghost btn-sm" href={`/admin/notices/${r.id}/edit`}>
                        <Pencil size={16} aria-hidden />
                        수정
                      </Link>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={pinBusy === r.id || (!r.pinned && pinnedCount >= PIN_MAX)}
                        onClick={() => void togglePin(r.id, !r.pinned)}
                      >
                        {r.pinned ? <PinOff size={16} aria-hidden /> : <Pin size={16} aria-hidden />}
                        {r.pinned ? '고정해제' : '고정'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => setConfirmRow(r)}
                      >
                        <Trash2 size={16} aria-hidden />
                        삭제
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>
      )}

      {confirmRow && (
        <ConfirmDialog
          title="공지를 삭제할까요?"
          body={`'${confirmRow.title}' 을(를) 삭제하면 공개 공지사항에서 즉시 사라집니다. 복구할 수 없습니다.`}
          confirmLabel="삭제"
          busy={removing}
          onConfirm={() => void remove(confirmRow.id)}
          onClose={() => setConfirmRow(null)}
        />
      )}
    </main>
  );
}
