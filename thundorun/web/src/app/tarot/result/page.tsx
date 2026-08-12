'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft } from 'lucide-react';
import { useTarotStore } from '@/store/tarotStore';
import { TAROT_DECK, TAROT_POSITIONS } from '@/lib/tarotDeck';
import Loading from '@/components/state/Loading';

export default function TarotResultPage() {
  const router = useRouter();
  const { topic, drawn, result, reset } = useTarotStore();

  useEffect(() => {
    if (!result) router.replace('/tarot');
  }, [result, router]);

  if (!result) {
    return (
      <main>
        <Loading label="불러오는 중…" />
      </main>
    );
  }

  const handleReset = () => {
    reset();
    router.push('/tarot');
  };

  return (
    <main>
      <div className="page-head">
        <div>
          <h1 className="page-title">타로 해석</h1>
          <p className="page-sub">{topic}</p>
        </div>
      </div>

      <div className="stack-6">
        {/* 뽑힌 3장 카드 */}
        <div className="grid-3">
          {drawn.map((drawnCard, idx) => {
            const card = TAROT_DECK.find((c) => c.id === drawnCard.cardId);
            if (!card) return null;
            return (
              <div className="card" key={drawnCard.cardId} style={{ aspectRatio: '2 / 3' }}>
                <span className="card-kicker">
                  {idx + 1}. {TAROT_POSITIONS[idx]}
                </span>
                <span className="card-title">{card.nameKo}</span>
                {drawnCard.reversed && <span className="tag tag-outline">역방향</span>}
              </div>
            );
          })}
        </div>

        {/* 마크다운 해석 */}
        <div className="stack-2">
          <div className="section-head">
            <h4>카드 해석</h4>
          </div>
          <div className="article">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{result.interpretation}</ReactMarkdown>
          </div>
        </div>
      </div>

      <hr className="hr" />
      <button className="btn btn-secondary" onClick={handleReset}>
        <ArrowLeft size={16} aria-hidden />
        다시 뽑기
      </button>
    </main>
  );
}
