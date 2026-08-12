'use client';

/**
 * NoticeForm.tsx — 공지 작성·수정 공용 폼 (클라이언트)
 * mode='create' → POST /api/admin/notices, mode='edit' → PATCH /api/admin/notices/[id].
 * 고정 토글은 5개 상한을 선제 disabled로 막지만, 레이스로 409가 나면 DB 트리거 응답으로 폴백.
 *
 * 표현은 Modernist Kit 전용(DESIGN.md §4.6 폼 · §7 폼 검증 · §4.13 다이얼로그).
 * 검증 시점 = blur 1차 + 제출 시 전체(타이핑 중 에러 표시 없음).
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import ConfirmDialog from '@/app/admin/ConfirmDialog';

interface NoticeInitial {
  title:  string;
  body:   string;
  pinned: boolean;
}

interface NoticeFormProps {
  mode: 'create' | 'edit';
  id?: string;
  initial?: NoticeInitial;
}

const TITLE_MAX = 120;
/** 고정 가능한 공지 최대 개수 — 서버 트리거와 같은 값. */
const PIN_MAX = 5;

export default function NoticeForm({ mode, id, initial }: NoticeFormProps) {
  const router = useRouter();
  const [title, setTitle]     = useState(initial?.title ?? '');
  const [body, setBody]       = useState(initial?.body ?? '');
  const [pinned, setPinned]   = useState(initial?.pinned ?? false);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');
  const [titleErr, setTitleErr] = useState('');
  const [bodyErr, setBodyErr]   = useState('');
  const [pinnedCount, setPinnedCount] = useState(0);
  const [askDelete, setAskDelete] = useState(false);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/admin/notices', { cache: 'no-store' });
        if (!res.ok) return;
        const rows = (await res.json()) as Array<{ id: string; pinned: boolean }>;
        setPinnedCount(rows.filter((r) => r.pinned && r.id !== id).length);
      } catch {
        // 조회 실패해도 폼 자체는 사용 가능 — 상한 선제 차단만 못 함(서버 트리거가 최종 방어선).
      }
    })();
  }, [id]);

  async function save() {
    const t = title.trim();
    const b = body.trim();
    setTitleErr(t ? '' : '제목은 필수입니다.');
    setBodyErr(b ? '' : '본문은 필수입니다.');
    if (!t || !b) {
      setError('필수 항목을 채워주세요.');
      return;
    }

    setSaving(true);
    setError('');
    try {
      const url    = mode === 'create' ? '/api/admin/notices' : `/api/admin/notices/${id}`;
      const method = mode === 'create' ? 'POST' : 'PATCH';
      const res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: t, body: b, pinned }),
      });
      const j = await res.json();
      if (res.ok && j.ok) {
        router.push('/admin/notices');
        return;
      }
      if (res.status === 409) {
        setError(j.error ?? `고정은 최대 ${PIN_MAX}개까지입니다. 관리 화면에서 확인하세요.`);
      } else {
        setError(j.error ?? `저장 실패 (${res.status})`);
      }
    } catch (e) {
      setError(`저장 오류: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!id) return;
    setRemoving(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/notices/${id}`, { method: 'DELETE' });
      const j = await res.json();
      if (res.ok && j.ok) {
        router.push('/admin/notices');
      } else {
        setError(j.error ?? `삭제 실패 (${res.status})`);
      }
    } catch (e) {
      setError(`삭제 오류: ${String(e)}`);
    } finally {
      setRemoving(false);
      setAskDelete(false);
    }
  }

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{mode === 'create' ? '새 공지' : '공지 수정'}</h1>
          <p className="page-sub">공개 공지사항에 노출됩니다. 고정은 최대 {PIN_MAX}개까지입니다.</p>
        </div>
      </div>

      <div className="stack-6">
        {error && (
          <div className="banner" data-tone="danger" role="alert">
            <span><b>저장하지 못했습니다</b><br />{error}</span>
          </div>
        )}

        <div className="card stack">
          <div className="field" data-invalid={!!titleErr}>
            <label htmlFor="notice-title">제목<span className="req">*</span></label>
            <input
              id="notice-title"
              className="input"
              maxLength={TITLE_MAX}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => setTitleErr(title.trim() ? '' : '제목은 필수입니다.')}
            />
            {titleErr
              ? <span className="field-error">{titleErr}</span>
              : <span className="field-hint">{title.length}/{TITLE_MAX}자</span>}
          </div>

          <div className="field" data-invalid={!!bodyErr}>
            <label htmlFor="notice-body">본문<span className="req">*</span></label>
            <textarea
              id="notice-body"
              className="input"
              rows={8}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onBlur={() => setBodyErr(body.trim() ? '' : '본문은 필수입니다.')}
            />
            {bodyErr
              ? <span className="field-error">{bodyErr}</span>
              : <span className="field-hint">마크다운·HTML 미지원, 줄바꿈만 반영됩니다.</span>}
          </div>

          <label className="switch">
            <input
              type="checkbox"
              checked={pinned}
              onChange={(e) => setPinned(e.target.checked)}
              disabled={!pinned && pinnedCount >= PIN_MAX}
            />
            <span className="track" />
            고정 (현재 {pinnedCount}/{PIN_MAX})
          </label>
        </div>

        <div className="row">
          {mode === 'edit' && (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={saving || removing}
              onClick={() => setAskDelete(true)}
            >
              <Trash2 size={16} aria-hidden />
              삭제
            </button>
          )}
          <div className="spacer" />
          <button
            type="button"
            className="btn btn-secondary"
            disabled={saving || removing}
            onClick={() => router.push('/admin/notices')}
          >
            취소
          </button>
          <button type="button" className="btn btn-primary" disabled={saving || removing} onClick={() => void save()}>
            {saving && <span className="spinner" />}
            {saving ? '저장 중…' : '저장'}
          </button>
        </div>
      </div>

      {askDelete && (
        <ConfirmDialog
          title="공지를 삭제할까요?"
          body="삭제하면 공개 공지사항에서 즉시 사라집니다. 복구할 수 없습니다."
          confirmLabel="삭제"
          busy={removing}
          onConfirm={() => void remove()}
          onClose={() => setAskDelete(false)}
        />
      )}
    </main>
  );
}
