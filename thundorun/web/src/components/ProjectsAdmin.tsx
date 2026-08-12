/**
 * ProjectsAdmin.tsx — 관리자 프로젝트 CRUD UI (클라이언트)
 * /api/admin/projects 를 호출해 목록·등록·수정·삭제.
 *
 * 표현은 Modernist Kit 전용(DESIGN.md §4.7 테이블 · §7 폼 · §6 상태 3종).
 * `embedded` 는 AdminDashboard 탭 안에 들어갈 때 — 이때는 `.page`/`.page-head` 를 만들지 않는다
 * (셸·페이지 골격은 라우트가 이미 갖고 있어 `<main>` 중첩을 피한다).
 */
'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import ConfirmDialog from '@/app/admin/ConfirmDialog';
import Empty from '@/components/state/Empty';
import ErrorState from '@/components/state/ErrorState';
import { TableSkeleton } from '@/components/state/Skeleton';

interface ProjectRow {
  id: string;
  title: string;
  period: string;
  role?: string;
  stack: string[];
  description: string;
  highlights: string[];
  link: string | null;
  sort_order: number;
  pinned: boolean;
  pinned_at?: string | null;
}

/** ⚠️ supabase/projects_pinned.sql 의 트리거 상한(6)과 반드시 같이 움직일 것. */
const PIN_MAX = 6;

const EMPTY: ProjectRow = {
  id: '', title: '', period: '', role: '', stack: [], description: '', highlights: [], link: '', sort_order: 0,
  pinned: false,
};

type SortKey = 'title' | 'sort_order';

export default function ProjectsAdmin({ embedded = false }: { embedded?: boolean }) {
  const [rows, setRows] = useState<ProjectRow[]>([]);
  const [form, setForm] = useState<ProjectRow>(EMPTY);
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState<string>('');
  const [msgTone, setMsgTone] = useState<'success' | 'danger'>('success');
  const [loadErr, setLoadErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [invalid, setInvalid] = useState<{ id?: string; title?: string }>({});
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadErr('');
    try {
      const res = await fetch('/api/admin/projects', { cache: 'no-store' });
      if (res.ok) setRows(await res.json());
      else setLoadErr(`목록 로드 실패 (${res.status})`);
    } catch (e) {
      setLoadErr(`목록 로드 오류: ${String(e)}`);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  function pick(p: ProjectRow) {
    setForm({ ...p, role: p.role ?? '', link: p.link ?? '' });
    setEditing(true);
    setInvalid({});
    setMsgTone('success');
    setMsg('수정 중: ' + p.id);
  }
  function reset() { setForm(EMPTY); setEditing(false); setInvalid({}); setMsg(''); }

  async function save() {
    const next: { id?: string; title?: string } = {};
    if (!form.id.trim()) next.id = 'id 는 필수입니다.';
    if (!form.title.trim()) next.title = '제목은 필수입니다.';
    setInvalid(next);
    if (next.id || next.title) {
      setMsgTone('danger');
      setMsg('필수 항목을 채워주세요.');
      return;
    }
    setSaving(true);
    const payload = { ...form, role: form.role || null, link: form.link || null };
    try {
      const res = await fetch('/api/admin/projects', {
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
    const res = await fetch('/api/admin/projects?id=' + encodeURIComponent(id), { method: 'DELETE' });
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
      // 고정은 사용자가 고른 순서 기준이라 정렬 키와 무관하게 항상 위에 둔다.
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (sort.key === 'title') return a.title.localeCompare(b.title, 'ko');
      return a.sort_order - b.sort_order;
    });
    return sort.dir === 'desc' ? out.reverse() : out;
  }, [rows, sort]);

  const pinnedCount = useMemo(
    () => rows.filter((r) => r.pinned && r.id !== form.id).length,
    [rows, form.id],
  );

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
          <h4>{editing ? '수정' : '새 프로젝트'}</h4>
          <span className="text-muted">DB: projects</span>
        </div>

        {msg && (
          <div className="banner" data-tone={msgTone} role="status">
            <span>{msg}</span>
          </div>
        )}

        <div className="grid-2">
          <div className="field" data-invalid={!!invalid.id}>
            <label htmlFor="pj-id">id (slug, 고유)<span className="req">*</span></label>
            <input
              id="pj-id"
              className="input"
              value={form.id}
              disabled={editing}
              onChange={(e) => setForm({ ...form, id: e.target.value })}
              placeholder="my-project"
            />
            {invalid.id
              ? <span className="field-error">{invalid.id}</span>
              : <span className="field-hint">등록 후에는 바꿀 수 없습니다.</span>}
          </div>
          <div className="field">
            <label htmlFor="pj-order">정렬순서</label>
            <input
              id="pj-order"
              className="input"
              type="number"
              value={form.sort_order}
              onChange={(e) => setForm({ ...form, sort_order: Number(e.target.value) })}
            />
          </div>
          <div className="field">
            <label className="switch">
              <input
                type="checkbox"
                checked={form.pinned}
                onChange={(e) => setForm({ ...form, pinned: e.target.checked })}
                disabled={!form.pinned && pinnedCount >= PIN_MAX}
              />
              <span className="track" />
              상단 고정 (현재 {pinnedCount}/{PIN_MAX})
            </label>
            <span className="field-hint">
              고정한 항목은 정렬순서와 무관하게 목록 맨 위에 나옵니다.
            </span>
          </div>
          <div className="field" data-invalid={!!invalid.title}>
            <label htmlFor="pj-title">제목<span className="req">*</span></label>
            <input
              id="pj-title"
              className="input"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="블로그 자동발행 파이프라인"
            />
            {invalid.title && <span className="field-error">{invalid.title}</span>}
          </div>
          <div className="field">
            <label htmlFor="pj-period">기간</label>
            <input
              id="pj-period"
              className="input"
              value={form.period}
              onChange={(e) => setForm({ ...form, period: e.target.value })}
              placeholder="2026"
            />
          </div>
          <div className="field">
            <label htmlFor="pj-role">역할</label>
            <input
              id="pj-role"
              className="input"
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="pj-link">링크 (없으면 비움)</label>
            <input
              id="pj-link"
              className="input"
              value={form.link ?? ''}
              onChange={(e) => setForm({ ...form, link: e.target.value })}
              placeholder="/blog"
            />
          </div>
        </div>

        <div className="field">
          <label htmlFor="pj-stack">스택 (쉼표 구분)</label>
          <input
            id="pj-stack"
            className="input"
            value={form.stack.join(', ')}
            onChange={(e) => setForm({ ...form, stack: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
          />
        </div>
        <div className="field">
          <label htmlFor="pj-desc">설명</label>
          <textarea
            id="pj-desc"
            className="input"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="pj-high">하이라이트 (한 줄에 하나)</label>
          <textarea
            id="pj-high"
            className="input"
            value={form.highlights.join('\n')}
            onChange={(e) => setForm({ ...form, highlights: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })}
          />
        </div>

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
          <span className="text-muted">{rows.length}건</span>
        </div>

        {loadErr ? (
          <ErrorState detail={loadErr} onRetry={() => void load()} />
        ) : !loading && rows.length === 0 ? (
          <Empty
            title="아직 프로젝트가 없습니다"
            body="위 폼에서 첫 프로젝트를 등록하면 메인페이지 카드에 노출됩니다."
          />
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th aria-sort={ariaSort('title')} onClick={() => toggleSort('title')}>제목</th>
                  <th>id</th>
                  <th>고정</th>
                  <th className="num" aria-sort={ariaSort('sort_order')} onClick={() => toggleSort('sort_order')}>정렬</th>
                  <th>스택</th>
                  <th />
                </tr>
              </thead>
              {loading ? (
                <TableSkeleton cols={5} />
              ) : (
                <tbody>
                  {sorted.map((p) => (
                    <tr key={p.id} data-selected={editing && form.id === p.id}>
                      <td>{p.title}</td>
                      <td className="text-mono">{p.id}</td>
                      <td>{p.pinned ? <span className="tag tag-success">고정</span> : null}</td>
                      <td className="num">{p.sort_order}</td>
                      <td className="text-muted">{p.stack.slice(0, 4).join(', ')}</td>
                      <td className="num">
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => pick(p)}>
                          <Pencil size={16} aria-hidden />
                          수정
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmId(p.id)}>
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
          title="프로젝트를 삭제할까요?"
          body={`'${confirmId}' 을(를) 삭제하면 메인페이지에서 즉시 사라집니다. 복구할 수 없습니다.`}
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
          <h1 className="page-title">프로젝트 관리</h1>
          <p className="page-sub">메인페이지 프로젝트 카드를 등록·수정·삭제합니다.</p>
        </div>
      </div>
      <div className="stack-6">{body}</div>
    </main>
  );
}
