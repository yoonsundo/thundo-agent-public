'use client';

/**
 * PasswordChangeForm — 비밀번호 변경 폼.
 *
 * 표현은 Modernist Kit 전용(DESIGN.md §4.6 폼 · §7 폼 검증).
 * 검증 시점 = blur 1차 + 제출 시 전체(타이핑 중 에러 표시 없음). 필드 오류는
 * `.field[data-invalid]` + `.field-error` 로 필드 하단에, 폼 전체 요약은 상단 배너에
 * **병행** 표시한다. 검증 규칙 자체는 기존과 같다(필수 · 8자 이상 · 새 비밀번호 일치).
 */
import { useState } from 'react';

/** 기존 HTML 제약(required · minLength=8)과 같은 규칙을 메시지로 표현한다. */
function validateNext(v: string): string {
  if (!v) return '새 비밀번호는 필수입니다.';
  if (v.length < 8) return '새 비밀번호는 8자 이상이어야 합니다.';
  return '';
}

const MISMATCH = '새 비밀번호가 서로 일치하지 않습니다.';

export default function PasswordChangeForm() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const [currentErr, setCurrentErr] = useState('');
  const [nextErr, setNextErr] = useState('');
  const [confirmErr, setConfirmErr] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSuccess('');

    // 클라 선검증 — 새 비밀번호 확인 불일치는 서버 왕복 전에 차단.
    if (next !== confirm) {
      setError(MISMATCH);
      setConfirmErr(MISMATCH);
      return;
    }
    setConfirmErr('');

    setLoading(true);
    try {
      const res = await fetch('/api/account/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };

      if (!res.ok || !data.ok) {
        setError(data.error ?? '비밀번호 변경에 실패했습니다.');
      } else {
        setSuccess('비밀번호가 변경되었습니다.');
        setCurrent('');
        setNext('');
        setConfirm('');
        setCurrentErr('');
        setNextErr('');
        setConfirmErr('');
      }
    } catch {
      setError('네트워크 오류로 비밀번호를 변경하지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="stack">
      {error && (
        <div className="banner" data-tone="danger" role="alert">
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="banner" data-tone="success" role="status">
          <span>{success}</span>
        </div>
      )}

      <div className="field" data-invalid={!!currentErr}>
        <label htmlFor="pw-current">현재 비밀번호<span className="req">*</span></label>
        <input
          id="pw-current"
          type="password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          onBlur={() => setCurrentErr(current ? '' : '현재 비밀번호는 필수입니다.')}
          required
          autoComplete="current-password"
          placeholder="현재 비밀번호"
          className="input"
        />
        {currentErr && <span className="field-error">{currentErr}</span>}
      </div>

      <div className="field" data-invalid={!!nextErr}>
        <label htmlFor="pw-next">새 비밀번호<span className="req">*</span></label>
        <input
          id="pw-next"
          type="password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          onBlur={() => setNextErr(validateNext(next))}
          required
          minLength={8}
          autoComplete="new-password"
          placeholder="8자 이상"
          className="input"
        />
        {nextErr
          ? <span className="field-error">{nextErr}</span>
          : <span className="field-hint">8자 이상 입력하세요.</span>}
      </div>

      <div className="field" data-invalid={!!confirmErr}>
        <label htmlFor="pw-confirm">새 비밀번호 확인<span className="req">*</span></label>
        <input
          id="pw-confirm"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          onBlur={() => setConfirmErr(confirm === next ? '' : MISMATCH)}
          required
          minLength={8}
          autoComplete="new-password"
          placeholder="새 비밀번호 재입력"
          className="input"
        />
        {confirmErr && <span className="field-error">{confirmErr}</span>}
      </div>

      <div className="row-end">
        <button type="submit" disabled={loading} className="btn btn-primary">
          {loading && <span className="spinner" />}
          {loading ? '변경 중…' : '비밀번호 변경'}
        </button>
      </div>
    </form>
  );
}
