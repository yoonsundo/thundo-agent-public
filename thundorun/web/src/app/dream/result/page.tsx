'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, Star, AlertTriangle, Moon, ChevronDown, ChevronUp, type LucideIcon } from 'lucide-react';
import { useDreamStore } from '@/store/dreamStore';
import type { DreamSymbol } from '@/store/dreamStore';
import Loading from '@/components/state/Loading';

type Verdict = '길몽' | '흉몽' | '평몽';

const VERDICT_META: Record<Verdict, { toneClass: string; Icon: LucideIcon }> = {
  길몽: { toneClass: 'tag-success', Icon: Star },
  흉몽: { toneClass: 'tag-danger', Icon: AlertTriangle },
  평몽: { toneClass: 'tag-neutral', Icon: Moon },
};

function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const { toneClass, Icon } = VERDICT_META[verdict];
  return (
    <span className={`tag ${toneClass}`}>
      <Icon size={14} aria-hidden />
      {verdict}
    </span>
  );
}

function SymbolList({ symbols }: { symbols: DreamSymbol[] }) {
  const [activeIdx, setActiveIdx] = useState<number | null>(null);

  if (symbols.length === 0) return null;
  const active = activeIdx !== null ? symbols[activeIdx] : null;

  return (
    <div className="stack-2">
      <div className="list">
        {symbols.map((sym, idx) => {
          const isActive = activeIdx === idx;
          return (
            <div className="list-row" key={idx}>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-expanded={isActive}
                onClick={() => setActiveIdx(isActive ? null : idx)}
              >
                {sym.name}
              </button>
              <span className="spacer" />
              {isActive ? <ChevronUp size={16} aria-hidden /> : <ChevronDown size={16} aria-hidden />}
            </div>
          );
        })}
      </div>
      {active && (
        <div className="banner" data-tone="info">
          <span>
            <b>{active.name}</b>
            <br />
            {active.meaning}
          </span>
        </div>
      )}
    </div>
  );
}

export default function DreamResultPage() {
  const router = useRouter();
  const { result, reset } = useDreamStore();

  useEffect(() => {
    if (!result) router.replace('/dream');
  }, [result, router]);

  if (!result) {
    return (
      <main>
        <Loading label="불러오는 중…" />
      </main>
    );
  }

  const { verdict, verdictSummary, symbols, luckyNumbers, interpretation } = result;

  const handleReset = () => {
    reset();
    router.push('/dream');
  };

  return (
    <main>
      <div className="page-head">
        <div>
          <h1 className="page-title">꿈해몽 결과</h1>
        </div>
      </div>

      <div className="stack-6">
        <div className="stack-2">
          <div className="section-head">
            <h4>길흉 판단</h4>
          </div>
          <VerdictBadge verdict={verdict} />
          <p>{verdictSummary}</p>
        </div>

        {symbols.length > 0 && (
          <div className="stack-2">
            <div className="section-head">
              <h4>핵심 상징</h4>
            </div>
            <SymbolList symbols={symbols} />
          </div>
        )}

        <div className="stack-2">
          <div className="section-head">
            <h4>행운의 번호</h4>
          </div>
          <div className="row">
            {luckyNumbers.map((n) => (
              <span key={n} className="avatar avatar-neutral">
                {n}
              </span>
            ))}
          </div>
        </div>

        <div className="stack-2">
          <div className="section-head">
            <h4>전체 해몽</h4>
          </div>
          <div className="article">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{interpretation}</ReactMarkdown>
          </div>
        </div>
      </div>

      <hr className="hr" />
      <button className="btn btn-secondary" onClick={handleReset}>
        <ArrowLeft size={16} aria-hidden />
        다시 보기
      </button>
    </main>
  );
}
