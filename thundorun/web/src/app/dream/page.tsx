'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDreamStore } from '@/store/dreamStore';
import ErrorState from '@/components/state/ErrorState';
import Loading from '@/components/state/Loading';

const MOOD_OPTIONS = [
  { id: '좋았어요', label: '좋았어요' },
  { id: '무서웠어요', label: '무서웠어요' },
  { id: '슬펐어요', label: '슬펐어요' },
  { id: '모르겠어요', label: '모르겠어요' },
];

export default function DreamHome() {
  const router = useRouter();
  const { input, setInput, setResult } = useDreamStore();
  const [loading, setLoading] = useState(false);
  const [fieldError, setFieldError] = useState('');
  const [apiError, setApiError] = useState('');

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setApiError('');

    if (!input.dreamText.trim()) {
      setFieldError('꿈 내용을 입력해주세요.');
      return;
    }
    setFieldError('');

    setLoading(true);
    try {
      const res = await fetch('/api/dream/interpret', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dreamText: input.dreamText,
          mood: input.mood || undefined,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `오류가 발생했습니다 (${res.status})`);
      }

      const data = await res.json();
      setResult(data);
      router.push('/dream/result');
    } catch (err) {
      setApiError(err instanceof Error ? err.message : '알 수 없는 오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main>
      <div className="page-head">
        <div>
          <h1 className="page-title">THUNDO 꿈해몽</h1>
          <p className="page-sub">꿈 내용을 입력하면 길흉과 숨겨진 의미를 풀어드립니다.</p>
        </div>
      </div>

      {apiError && <ErrorState detail={apiError} onRetry={() => handleSubmit()} />}

      <form onSubmit={handleSubmit} className="stack-6">
        <div className="field" data-invalid={!!fieldError}>
          <label htmlFor="dream-text">꿈에서 무슨 일이 있었나요?</label>
          <textarea
            id="dream-text"
            className="input"
            placeholder="예: 하늘을 날아다니는 꿈을 꿨어요. 처음엔 무서웠는데 나중엔 기분이 좋아졌어요."
            value={input.dreamText}
            onChange={(e) => setInput({ dreamText: e.target.value })}
            rows={5}
          />
          {fieldError ? (
            <span className="field-error">{fieldError}</span>
          ) : (
            <span className="field-hint">최대한 구체적으로 적을수록 해몽이 정확해집니다.</span>
          )}
        </div>

        <div className="field">
          <label>
            꿈의 분위기 <span className="text-muted">(선택)</span>
          </label>
          <div className="grid-2">
            {MOOD_OPTIONS.map(({ id, label }) => (
              <label key={id} className="radio">
                <input
                  type="radio"
                  name="mood"
                  value={id}
                  checked={input.mood === id}
                  onChange={() => setInput({ mood: id })}
                />
                <span className="dot" />
                {label}
              </label>
            ))}
          </div>
        </div>

        <button className="btn btn-primary btn-block" type="submit" disabled={loading}>
          꿈 해몽하기
        </button>
        {loading && <Loading label="해몽 보는 중…" />}
      </form>
    </main>
  );
}
