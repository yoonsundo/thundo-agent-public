'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check } from 'lucide-react';
import { useSajuStore } from '@/store/sajuStore';

const FORTUNE_OPTIONS = [
  { id: '원국',    label: '사주 원국' },
  { id: '대운',    label: '대운' },
  { id: '세운',    label: '세운(올해)' },
  { id: '월운',    label: '월운' },
  { id: '연애운',  label: '연애운' },
  { id: '결혼운',  label: '결혼운' },
  { id: '재물운',  label: '재물운' },
  { id: '취업운',  label: '취업·직업운' },
  { id: '사업운',  label: '사업운' },
  { id: '건강운',  label: '건강운' },
  { id: '학업운',  label: '학업운' },
  { id: '가족운',  label: '가족운' },
  { id: '이사운',  label: '이사운' },
  { id: '오늘운세', label: '오늘의 운세' },
  { id: '궁합',    label: '궁합' },
];

interface PartnerInfo {
  name: string;
  gender: string;
  birthDate: string;
  birthTime: string;
}

export default function SajuHome() {
  const router = useRouter();
  const { input, setInput, setResult } = useSajuStore();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [partnerInfo, setPartnerInfo] = useState<PartnerInfo>({
    name: '', gender: '', birthDate: '', birthTime: '',
  });

  const toggleFortune = (id: string) => {
    if (id === '원국') return;
    const next = input.fortuneTypes.includes(id)
      ? input.fortuneTypes.filter((f) => f !== id)
      : [...input.fortuneTypes, id];
    setInput({ fortuneTypes: next });
  };

  const isGunghapChecked = input.fortuneTypes.includes('궁합');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!input.name.trim()) { setError('이름을 입력해주세요.'); return; }
    if (!input.gender)      { setError('성별을 선택해주세요. (대운 계산에 필요합니다)'); return; }
    if (!input.birthDate)   { setError('생년월일을 입력해주세요.'); return; }
    if (input.fortuneTypes.length === 0) { setError('볼 운을 1개 이상 선택해주세요.'); return; }

    if (isGunghapChecked) {
      if (!partnerInfo.name.trim()) { setError('궁합 분석을 위해 상대방 이름을 입력해주세요.'); return; }
      if (!partnerInfo.birthDate)   { setError('궁합 분석을 위해 상대방 생년월일을 입력해주세요.'); return; }
    }

    setLoading(true);
    try {
      const res = await fetch('/api/saju/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: input.name,
          birthDate: input.birthDate,
          birthTime: input.birthTime || undefined,
          gender: input.gender,
          fortuneTypes: input.fortuneTypes,
          partner: isGunghapChecked
            ? {
                name: partnerInfo.name,
                birthDate: partnerInfo.birthDate,
                gender: partnerInfo.gender || undefined,
                birthTime: partnerInfo.birthTime || undefined,
              }
            : undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `오류가 발생했습니다 (${res.status})`);
      }
      const data = await res.json();
      setResult(data);
      router.push('/saju/result');
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
          <p className="page-sub">생년월일과 이름을 입력하면 만세력으로 사주를 풀어드립니다.</p>
        </div>
      </div>

      <ol className="stepper">
        <li aria-current="step">정보 입력</li>
        <li>결과 확인</li>
      </ol>

      {error && (
        <div className="banner" data-tone="danger" role="alert">
          <span>{error}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="stack-6">
        <div className="card stack">
          <span className="card-kicker">기본 정보</span>

          <div className="field">
            <label htmlFor="name">이름<span className="req">*</span></label>
            <input
              id="name"
              className="input"
              type="text"
              placeholder="홍길동"
              value={input.name}
              onChange={(e) => setInput({ name: e.target.value })}
            />
          </div>

          <div className="field">
            <label>성별<span className="req">*</span> <span className="text-muted">(대운 계산에 필요)</span></label>
            <div className="row">
              {(['male', 'female'] as const).map((g) => (
                <label key={g} className="radio">
                  <input
                    type="radio"
                    name="gender"
                    value={g}
                    checked={input.gender === g}
                    onChange={() => setInput({ gender: g })}
                  />
                  <span className="dot" />
                  {g === 'male' ? '남성' : '여성'}
                </label>
              ))}
            </div>
          </div>

          <div className="grid-2">
            <div className="field">
              <label htmlFor="birthDate">생년월일<span className="req">*</span> <span className="text-muted">(양력)</span></label>
              <input
                id="birthDate"
                className="input"
                type="date"
                value={input.birthDate}
                onChange={(e) => setInput({ birthDate: e.target.value })}
              />
            </div>

            <div className="field">
              <label htmlFor="birthTime">태어난 시간 <span className="text-muted">(선택 — 없으면 시주 제외)</span></label>
              <input
                id="birthTime"
                className="input"
                type="time"
                value={input.birthTime}
                onChange={(e) => setInput({ birthTime: e.target.value })}
              />
            </div>
          </div>
        </div>

        <div className="card stack">
          <span className="card-kicker">볼 운 선택</span>
          <div className="grid-3">
            {FORTUNE_OPTIONS.map(({ id, label }) => (
              <label key={id} className="check">
                <input
                  type="checkbox"
                  checked={input.fortuneTypes.includes(id)}
                  onChange={() => toggleFortune(id)}
                  disabled={id === '원국'}
                />
                <span className="box"><Check size={11} aria-hidden /></span>
                {label}
              </label>
            ))}
          </div>

          {isGunghapChecked && (
            <div className="stack" style={{ borderTop: '1px dashed var(--color-divider)', paddingTop: 'var(--space-4)' }}>
              <span className="card-kicker">상대방 정보</span>

              <div className="field">
                <label htmlFor="partnerName">이름</label>
                <input
                  id="partnerName"
                  className="input"
                  type="text"
                  placeholder="상대방 이름"
                  value={partnerInfo.name}
                  onChange={(e) => setPartnerInfo((p) => ({ ...p, name: e.target.value }))}
                />
              </div>

              <div className="field">
                <label>성별 <span className="text-muted">(선택)</span></label>
                <div className="row">
                  {(['male', 'female'] as const).map((g) => (
                    <label key={g} className="radio">
                      <input
                        type="radio"
                        name="partnerGender"
                        value={g}
                        checked={partnerInfo.gender === g}
                        onChange={() => setPartnerInfo((p) => ({ ...p, gender: g }))}
                      />
                      <span className="dot" />
                      {g === 'male' ? '남성' : '여성'}
                    </label>
                  ))}
                </div>
              </div>

              <div className="grid-2">
                <div className="field">
                  <label htmlFor="partnerBirthDate">생년월일 <span className="text-muted">(양력)</span></label>
                  <input
                    id="partnerBirthDate"
                    className="input"
                    type="date"
                    value={partnerInfo.birthDate}
                    onChange={(e) => setPartnerInfo((p) => ({ ...p, birthDate: e.target.value }))}
                  />
                </div>

                <div className="field">
                  <label htmlFor="partnerBirthTime">태어난 시간 <span className="text-muted">(선택)</span></label>
                  <input
                    id="partnerBirthTime"
                    className="input"
                    type="time"
                    value={partnerInfo.birthTime}
                    onChange={(e) => setPartnerInfo((p) => ({ ...p, birthTime: e.target.value }))}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        <button className="btn btn-primary btn-block" type="submit" disabled={loading}>
          {loading && <span className="spinner" />}
          {loading ? '사주 보는 중…' : '사주 보기'}
        </button>
      </form>
    </div>
  );
}
