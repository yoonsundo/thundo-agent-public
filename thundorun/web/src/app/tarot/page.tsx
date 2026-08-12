'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles } from 'lucide-react';
import { useTarotStore } from '@/store/tarotStore';
import { TAROT_DECK, TAROT_POSITIONS } from '@/lib/tarotDeck';
import ErrorState from '@/components/state/ErrorState';
import Loading from '@/components/state/Loading';

const TOPIC_OPTIONS = [
  '연애',
  '금전·재물',
  '직업·일',
  '인간관계',
  '건강',
  '오늘의 운세',
];

// 22장 배열을 무작위로 섞는다
function shuffle<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export default function TarotHome() {
  const router = useRouter();
  const { setTopic, setDrawn, setResult } = useTarotStore();

  const [selectedTopic, setSelectedTopic] = useState('');
  // 셔플된 22장 카드 순서 (id 배열)
  const shuffledDeck = useMemo(() => shuffle(TAROT_DECK), []);

  // 뒤집힌 카드들: cardId → reversed 여부
  const [flippedCards, setFlippedCards] = useState<Map<number, boolean>>(new Map());
  // 선택 순서: 최대 3장
  const [selectedOrder, setSelectedOrder] = useState<number[]>([]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleTopicSelect = (topic: string) => {
    setSelectedTopic(topic);
    // 주제 바꾸면 카드 선택 초기화
    setFlippedCards(new Map());
    setSelectedOrder([]);
  };

  const handleCardClick = (cardId: number) => {
    if (!selectedTopic) return;
    // 이미 3장 선택 완료된 뒤엔 추가 클릭 무시
    if (selectedOrder.length >= 3 && !selectedOrder.includes(cardId)) return;
    // 이미 뽑은 카드는 재클릭 무시
    if (selectedOrder.includes(cardId)) return;

    const reversed = Math.random() < 0.5;
    setFlippedCards((prev) => new Map(prev).set(cardId, reversed));
    setSelectedOrder((prev) => [...prev, cardId]);
  };

  const handleSubmit = async () => {
    if (selectedOrder.length < 3 || !selectedTopic) return;
    setError('');
    setLoading(true);

    const cards = selectedOrder.map((cardId) => {
      const card = TAROT_DECK.find((c) => c.id === cardId)!;
      return { id: cardId, nameKo: card.nameKo, reversed: flippedCards.get(cardId) ?? false };
    });

    try {
      const res = await fetch('/api/tarot/interpret', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: selectedTopic, cards }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `오류가 발생했습니다 (${res.status})`);
      }

      const data = await res.json();
      setTopic(selectedTopic);
      setDrawn(
        selectedOrder.map((cardId) => ({
          cardId,
          reversed: flippedCards.get(cardId) ?? false,
        }))
      );
      setResult(data);
      router.push('/tarot/result');
    } catch (err) {
      setError(err instanceof Error ? err.message : '알 수 없는 오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  };

  const canSubmit = selectedOrder.length === 3 && !loading;

  return (
    <main>
      <div className="page-head">
        <div>
          <h1 className="page-title">THUNDO 타로</h1>
          <p className="page-sub">카드 3장이 당신의 이야기를 들려줍니다.</p>
        </div>
      </div>

      {error && <ErrorState detail={error} onRetry={handleSubmit} />}

      <div className="stack-6">
        {/* 1단계: 주제 선택 */}
        <div className="stack">
          <div className="section-head">
            <h4>주제를 선택해주세요</h4>
          </div>
          <div className="grid-3">
            {TOPIC_OPTIONS.map((topic) => (
              <label key={topic} className="radio">
                <input
                  type="radio"
                  name="topic"
                  value={topic}
                  checked={selectedTopic === topic}
                  onChange={() => handleTopicSelect(topic)}
                />
                <span className="dot" />
                {topic}
              </label>
            ))}
          </div>
        </div>

        {/* 2단계: 카드 선택 (주제 선택 후 표시) */}
        {selectedTopic && (
          <div className="stack">
            <div className="section-head">
              <h4>카드 3장을 뽑아주세요</h4>
              {selectedOrder.length > 0 && (
                <span className="text-muted">{selectedOrder.length}/3</span>
              )}
            </div>

            {/* 카드 위치 의미 안내 */}
            <div className="list">
              {TAROT_POSITIONS.map((meaning, idx) => (
                <div className="list-row" key={idx}>
                  <span className="avatar avatar-neutral">{idx + 1}</span>
                  <span>{meaning}</span>
                </div>
              ))}
            </div>

            <div className="grid-auto-sm">
              {shuffledDeck.map((card) => {
                const isFlipped = flippedCards.has(card.id);
                const isReversed = flippedCards.get(card.id) ?? false;
                const orderIdx = selectedOrder.indexOf(card.id);
                const isDone = selectedOrder.length >= 3 && !isFlipped;

                return (
                  <button
                    key={card.id}
                    type="button"
                    className={isFlipped ? 'card' : 'card card-outline'}
                    aria-pressed={isFlipped}
                    aria-label={!isFlipped ? '카드 뽑기' : undefined}
                    disabled={isDone}
                    onClick={() => handleCardClick(card.id)}
                    style={
                      isFlipped
                        ? { aspectRatio: '2 / 3' }
                        // 뒷면은 아이콘 하나뿐이라 가운데 정렬해야 '카드 뒷면'으로 읽힌다.
                        // (.card 는 flex-column 이라 그냥 두면 아이콘이 좌상단에 붙어 빈 상자처럼 보였다)
                        : { aspectRatio: '2 / 3', alignItems: 'center', justifyContent: 'center' }
                    }
                  >
                    {isFlipped ? (
                      <>
                        <span className="card-kicker">No. {card.id}</span>
                        <span className="card-title">{card.nameKo}</span>
                        <span className="row">
                          <span className="badge">{orderIdx + 1}</span>
                          {isReversed && <span className="tag tag-outline">역방향</span>}
                        </span>
                      </>
                    ) : (
                      <span className="text-muted"><Sparkles size={20} aria-hidden /></span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* 해석 보기 버튼 */}
      {selectedTopic && (
        <>
          <button
            className="btn btn-primary btn-block"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {selectedOrder.length < 3
              ? `카드를 ${3 - selectedOrder.length}장 더 선택해주세요`
              : '해석 보기'}
          </button>
          {loading && <Loading label="카드를 읽는 중…" />}
        </>
      )}
    </main>
  );
}
