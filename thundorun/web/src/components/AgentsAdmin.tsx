/**
 * AgentsAdmin.tsx — 관리자 에이전트 CRUD UI (클라이언트)
 * /api/admin/agents 를 호출해 목록·등록·수정·삭제.
 *
 * 표현은 Modernist Kit 전용(DESIGN.md §4.7 테이블 · §7 폼 · §6 상태 3종).
 * `embedded` 는 AdminDashboard 탭 안에 들어갈 때 — 이때는 `.page`/`.page-head` 를 만들지 않는다.
 */
'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import AgentAvatar from '@/components/ui/AgentAvatar';
import { Check, Pencil, Plus, Trash2 } from 'lucide-react';
import ConfirmDialog from '@/app/admin/ConfirmDialog';
import Empty from '@/components/state/Empty';
import ErrorState from '@/components/state/ErrorState';
import { TableSkeleton } from '@/components/state/Skeleton';

interface AgentRow {
  id:          string;
  name:        string;
  role:        string;
  description: string;
  image_url:   string | null;
  /**
   * 서버(`server/agents.ts`)가 기본값을 채워 내려보내는 데이터 필드.
   * 규칙 8(이모지 금지)·§12.8 — **UI 는 이 값을 렌더하지 않고 입력칸도 두지 않는다.**
   * 저장 시에는 불러온 값을 그대로 되돌려 보내 기존 데이터를 훼손하지 않는다.
   * 화면상의 에이전트 식별은 `.avatar` 이니셜로 통일한다(§12.9).
   */
  emoji:       string;
  sort_order:  number;
  active:      boolean;
}

/** 에이전트 식별 아바타 이니셜 — 이모지 대체. */
const EMPTY: AgentRow = {
  id: '', name: '', role: '', description: '', image_url: '', emoji: '', sort_order: 0, active: true,
};

type SortKey = 'name' | 'sort_order';

export default function AgentsAdmin({ embedded = false }: { embedded?: boolean }) {
  const [rows, setRows] = useState<AgentRow[]>([]);
  const [form, setForm] = useState<AgentRow>(EMPTY);
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState<string>('');
  const [msgTone, setMsgTone] = useState<'success' | 'danger'>('success');
  const [loadErr, setLoadErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [invalid, setInvalid] = useState<{ id?: string; name?: string }>({});
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadErr('');
    try {
      const res = await fetch('/api/admin/agents', { cache: 'no-store' });
      if (res.ok) setRows(await res.json());
      else setLoadErr(`목록 로드 실패 (${res.status})`);
    } catch (e) {
      setLoadErr(`목록 로드 오류: ${String(e)}`);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  function pick(a: AgentRow) {
    setForm({ ...a, image_url: a.image_url ?? '' });
    setEditing(true);
    setInvalid({});
    setMsgTone('success');
    setMsg('수정 중: ' + a.id);
  }
  function reset() { setForm(EMPTY); setEditing(false); setInvalid({}); setMsg(''); }

  async function save() {
    const next: { id?: string; name?: string } = {};
    if (!form.id.trim()) next.id = 'id 는 필수입니다.';
    if (!form.name.trim()) next.name = '이름은 필수입니다.';
    setInvalid(next);
    if (next.id || next.name) {
      setMsgTone('danger');
      setMsg('필수 항목을 채워주세요.');
      return;
    }
    setSaving(true);
    const payload = { ...form, image_url: form.image_url || null };
    try {
      const res = await fetch('/api/admin/agents', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const j = await res.json();
      if (res.ok && j.ok) {
        setMsgTone('success');
        setMsg('저장됨: ' + form.id);
        reset();
        await load();
      } else {
        setMsgTone('danger');
        setMsg('저장 실패: ' + (j.error || res.status));
      }
    } finally { setSaving(false); }
  }

  async function remove(id: string) {
    setConfirmId(null);
    const res = await fetch('/api/admin/agents?id=' + encodeURIComponent(id), { method: 'DELETE' });
    const j = await res.json();
    if (res.ok && j.ok) {
      setMsgTone('success');
      setMsg('삭제됨: ' + id);
      await load();
    } else {
      setMsgTone('danger');
      setMsg('삭제 실패: ' + (j.error || res.status));
    }
  }

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const out = [...rows].sort((a, b) => {
      if (sort.key === 'name') return a.name.localeCompare(b.name, 'ko');
      return a.sort_order - b.sort_order;
    });
    return sort.dir === 'desc' ? out.reverse() : out;
  }, [rows, sort]);

  const ariaSort = (key: SortKey) =>
    sort?.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
  const toggleSort = (key: SortKey) =>
    setSort((cur) => (cur?.key === key ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  const body = (
    <>
      {/* 등록·수정 폼 */}
      <div className="card stack">
        <div className="section-head">
          {editing ? <Pencil size={18} aria-hidden /> : <Plus size={18} aria-hidden />}
          <h4>{editing ? '수정' : '새 에이전트'}</h4>
          <span className="text-muted">DB: agents</span>
        </div>

        {msg && (
          <div className="banner" data-tone={msgTone} role="status">
            <span>{msg}</span>
          </div>
        )}

        <div className="grid-2">
          <div className="field" data-invalid={!!invalid.id}>
            <label htmlFor="ag-id">id (slug, 고유)<span className="req">*</span></label>
            <input
              id="ag-id"
              className="input"
              value={form.id}
              disabled={editing}
              onChange={(e) => setForm({ ...form, id: e.target.value })}
              placeholder="lion"
            />
            {invalid.id
              ? <span className="field-error">{invalid.id}</span>
              : <span className="field-hint">등록 후에는 바꿀 수 없습니다.</span>}
          </div>
          <div className="field">
            <label htmlFor="ag-order">정렬순서</label>
            <input
              id="ag-order"
              className="input"
              type="number"
              value={form.sort_order}
              onChange={(e) => setForm({ ...form, sort_order: Number(e.target.value) })}
            />
          </div>
          <div className="field" data-invalid={!!invalid.name}>
            <label htmlFor="ag-name">이름<span className="req">*</span></label>
            <input
              id="ag-name"
              className="input"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Lion"
            />
            {invalid.name && <span className="field-error">{invalid.name}</span>}
          </div>
          <div className="field">
            <label htmlFor="ag-role">역할</label>
            <input
              id="ag-role"
              className="input"
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
              placeholder="오케스트레이터"
            />
          </div>
          <div className="field">
            <label htmlFor="ag-img">아바타 이미지</label>
            {/* 아바타의 단일 출처는 이 값이다 — 소개 카드·홈 미리보기·흐름도·대화가 모두 이걸 읽는다.
                비우면 역할 아이콘, 그다음 모노그램 순으로 떨어지므로 빈 원이 뜨는 일은 없다. */}
            <div className="row" style={{ alignItems: 'center', gap: 'var(--space-3)' }}>
              <AgentAvatar id={form.id} name={form.name || form.id} imageUrl={form.image_url} />
              <div className="stack-2" style={{ flex: 1, minWidth: 0 }}>
                <input
                  id="ag-img"
                  className="input"
                  value={form.image_url ?? ''}
                  onChange={(e) => setForm({ ...form, image_url: e.target.value })}
                  placeholder="/agent-portraits/lion.jpg 또는 https://..."
                />
                <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setForm({ ...form, image_url: `/agent-portraits/${form.id}.jpg` })}
                    disabled={!form.id}
                    title="이 에이전트 id 로 등록된 마스코트 초상을 쓴다"
                  >
                    기본 초상 사용
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setForm({ ...form, image_url: '' })}
                    disabled={!form.image_url}
                    title="비우면 역할 아이콘, 그다음 모노그램으로 떨어진다"
                  >
                    이미지 삭제
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="field">
          <label htmlFor="ag-desc">설명</label>
          <textarea
            id="ag-desc"
            className="input"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </div>

        <label className="check">
          <input
            type="checkbox"
            checked={form.active}
            onChange={(e) => setForm({ ...form, active: e.target.checked })}
          />
          <span className="box"><Check size={11} aria-hidden /></span>
          활성(active) — 공개 페이지에 노출
        </label>

        <div className="row-end">
          {editing && (
            <button type="button" className="btn btn-secondary" onClick={reset} disabled={saving}>취소</button>
          )}
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
            {saving && <span className="spinner" />}
            {editing ? '수정 저장' : '등록'}
          </button>
        </div>
      </div>

      {/* 목록 */}
      <div>
        <div className="section-head">
          <h4>목록</h4>
          <span className="text-muted">{rows.length}마리</span>
        </div>

        {loadErr ? (
          <ErrorState detail={loadErr} onRetry={() => void load()} />
        ) : !loading && rows.length === 0 ? (
          <Empty
            title="아직 등록된 에이전트가 없습니다"
            body="위 폼에서 첫 에이전트를 등록하면 공개 소개 페이지에 카드가 만들어집니다."
          />
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th aria-sort={ariaSort('name')} onClick={() => toggleSort('name')}>이름</th>
                  <th>id</th>
                  <th>역할</th>
                  <th className="num" aria-sort={ariaSort('sort_order')} onClick={() => toggleSort('sort_order')}>정렬</th>
                  <th>노출</th>
                  <th />
                </tr>
              </thead>
              {loading ? (
                <TableSkeleton cols={6} />
              ) : (
                <tbody>
                  {sorted.map((a) => (
                    <tr key={a.id} data-selected={editing && form.id === a.id}>
                      <td>
                        {/* 아바타는 DB image_url 이 단일 출처 — 아래 폼에서 바꾸면 여기도 바뀐다.
                            (이모지는 쓰지 않는다 §12.3 · 초상/역할아이콘/모노그램 순 폴백) */}
                        <span className="row">
                          <AgentAvatar id={a.id} name={a.name} imageUrl={a.image_url} sizeClass="" />
                          {a.name}
                        </span>
                      </td>
                      <td className="text-mono">{a.id}</td>
                      <td className="text-muted">{a.role}</td>
                      <td className="num">{a.sort_order}</td>
                      <td>
                        <span className={a.active ? 'tag tag-success' : 'tag tag-neutral'}>
                          {a.active ? '활성' : '비활성'}
                        </span>
                      </td>
                      <td className="num">
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => pick(a)}>
                          <Pencil size={16} aria-hidden />
                          수정
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmId(a.id)}>
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
      </div>

      {confirmId && (
        <ConfirmDialog
          title="에이전트를 삭제할까요?"
          body={`'${confirmId}' 을(를) 삭제하면 공개 소개 페이지에서 즉시 사라집니다. 복구할 수 없습니다.`}
          confirmLabel="삭제"
          onConfirm={() => void remove(confirmId)}
          onClose={() => setConfirmId(null)}
        />
      )}
    </>
  );

  if (embedded) return <div className="stack-6">{body}</div>;

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">에이전트 관리</h1>
          <p className="page-sub">에이전트 소개 카드를 등록·수정·삭제합니다.</p>
        </div>
      </div>
      <div className="stack-6">{body}</div>
    </main>
  );
}
