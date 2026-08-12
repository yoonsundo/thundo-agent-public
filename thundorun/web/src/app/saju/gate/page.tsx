'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

function GateForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!code.trim()) {
      setError('비밀코드를 입력해주세요.');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/saju/gate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? '코드가 올바르지 않습니다.');
      }
      const next = searchParams.get('next');
      // 오픈 리다이렉트 방지 — /saju, /dream, /tarot 내부 경로만 허용
      const allowed = ['/saju', '/dream', '/tarot'];
      router.replace(next && allowed.some((p) => next.startsWith(p)) ? next : '/saju');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '알 수 없는 오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page-narrow">
      <div className="page-head">
        <div>
          <h1 className="page-title">THUNDO 사주</h1>
          <p className="page-sub">초대받은 분만 입장할 수 있어요. 비밀코드를 입력해주세요.</p>
        </div>
      </div>

      {error && (
        <div className="banner" data-tone="danger" role="alert">
          <span>{error}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="stack-6">
        <div className="card stack">
          <div className="field">
            <label htmlFor="gateCode">비밀코드<span className="req">*</span></label>
            <input
              id="gateCode"
              className="input"
              type="text"
              placeholder="비밀코드"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoFocus
            />
          </div>
        </div>
        <button className="btn btn-primary btn-block" type="submit" disabled={loading}>
          {loading && <span className="spinner" />}
          {loading ? '확인 중…' : '입장하기'}
        </button>
      </form>
    </div>
  );
}

export default function GatePage() {
  return (
    <Suspense>
      <GateForm />
    </Suspense>
  );
}
