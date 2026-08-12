'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft } from 'lucide-react';
import { useSajuStore } from '@/store/sajuStore';
import Loading from '@/components/state/Loading';
import type { Pillar } from '@/lib/manseryeok';

function PillarCard({ label, pillar }: { label: string; pillar: Pillar | null }) {
  if (!pillar) {
    return (
      <div className="card" style={{ opacity: 0.4 }}>
        <span className="card-kicker">{label}</span>
        <span className="card-title">미입력</span>
      </div>
    );
  }
  return (
    <div className="card">
      <span className="card-kicker">{label}</span>
      <span className="card-title">
        {pillar.stemHanja}
        <br />
        {pillar.branchHanja}
      </span>
      <div className="card-meta">
        {pillar.stem}{pillar.branch} · {pillar.stemElement}·{pillar.branchElement}
      </div>
    </div>
  );
}

export default function SajuResultPage() {
  const router = useRouter();
  const { input, result, reset } = useSajuStore();

  useEffect(() => {
    if (!result) router.replace('/saju');
  }, [result, router]);

  if (!result) {
    return (
      <div className="page-narrow">
        <Loading label="불러오는 중…" />
      </div>
    );
  }

  const { pillars, interpretations } = result;

  const handleReset = () => {
    reset();
    router.push('/saju');
  };

  return (
    <div className="page-narrow">
      <div className="page-head">
        <div>
          <h1 className="page-title">사주 풀이</h1>
        </div>
      </div>

      <ol className="stepper">
        <li data-state="done">정보 입력</li>
        <li aria-current="step">결과 확인</li>
      </ol>

      <div className="row" style={{ flexWrap: 'wrap', marginBottom: 'var(--space-6)' }}>
        <span className="tag tag-neutral">{input.name}</span>
        <span className="tag tag-neutral">{input.birthDate}</span>
        {input.birthTime && <span className="tag tag-neutral">{input.birthTime}</span>}
        {input.gender && (
          <span className="tag tag-neutral">{input.gender === 'male' ? '남성' : '여성'}</span>
        )}
      </div>

      <div className="stack-6">
        <div className="card stack">
          <span className="card-kicker">사주 원국 (四柱)</span>
          <div className="grid-4">
            <PillarCard label="년주 (年柱)" pillar={pillars.year} />
            <PillarCard label="월주 (月柱)" pillar={pillars.month} />
            <PillarCard label="일주 (日柱)" pillar={pillars.day} />
            <PillarCard label="시주 (時柱)" pillar={pillars.hour} />
          </div>
        </div>

        {interpretations.map(({ type, text }) => (
          <div key={type} className="card stack">
            <h4>{type}</h4>
            <div className="article">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
            </div>
          </div>
        ))}

        <button className="btn btn-secondary" onClick={handleReset}>
          <ArrowLeft size={16} aria-hidden />
          다시 보기
        </button>
      </div>
    </div>
  );
}
