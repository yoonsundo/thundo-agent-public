'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CircleCheck, CircleX, RotateCcw, FileText } from 'lucide-react';
import { buildQuiz, gradeFor, LEVEL_LABEL, type ShuffledQuestion } from '@/lib/kboQuiz';

/**
 * QuizBoard — KBO 상식 퀴즈. 겉모습은 사내 업무 점검 도구다.
 *
 * 왜 업무처럼 보이게 하나: 사용자가 "회사에서 몰래" 쓰겠다고 했다. 그래서 화려한 색·이모지·
 * 축하 연출을 전부 뺐다. 문항은 '검토 항목', 점수는 '처리율', 정답/오답은 상태 태그로 보인다.
 * 옆자리에서 흘깃 보면 체크리스트 채우는 화면과 구분되지 않아야 한다.
 *
 * 보스키(Esc): 즉시 위장 화면으로 덮는다. 되돌릴 때까지 문항이 화면에서 완전히 사라진다 —
 * 흐리게 처리하는 정도로는 글자가 읽히므로 아예 렌더하지 않는다.
 */

/** 30분 정도 걸리도록 한 세션 분량. 문항이 늘어도 한 번에 다 내지 않는다. */
const SESSION_SIZE = 30;

export default function QuizBoard() {
  const [quiz, setQuiz] = useState<ShuffledQuestion[]>([]);
  const [idx, setIdx] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [correct, setCorrect] = useState(0);
  const [done, setDone] = useState(false);
  const [hidden, setHidden] = useState(false);

  // 문항 섞기는 클라이언트에서만 — 서버에서 섞으면 렌더 결과가 매번 달라져 하이드레이션이 깨진다.
  useEffect(() => { setQuiz(buildQuiz(Math.random, SESSION_SIZE)); }, []);

  const reset = useCallback(() => {
    setQuiz(buildQuiz(Math.random, SESSION_SIZE));
    setIdx(0); setPicked(null); setCorrect(0); setDone(false);
  }, []);

  // 보스키. 입력 중에는 가로채지 않는다(메모 칸에 Esc 를 누를 수도 있다).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (e.key === 'Escape') { e.preventDefault(); setHidden(h => !h); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const current = quiz[idx];
  const progress = quiz.length ? Math.round(((done ? quiz.length : idx) / quiz.length) * 100) : 0;
  const grade = useMemo(() => gradeFor(correct, quiz.length), [correct, quiz.length]);

  function choose(i: number) {
    if (picked !== null || !current) return;
    setPicked(i);
    if (i === current.shuffledAnswer) setCorrect(c => c + 1);
  }
  function next() {
    setPicked(null);
    if (idx + 1 >= quiz.length) setDone(true);
    else setIdx(i => i + 1);
  }

  // ── 위장 화면 ── 퀴즈를 아예 렌더하지 않는다(흐리게 두면 읽힌다).
  if (hidden) {
    return (
      <div className="container">
        <div className="page-head">
          <div>
            <p className="kicker">내부 문서</p>
            <h1 className="page-title">분기 운영 점검 보고서</h1>
            <p className="page-sub">작성 중 · 자동 저장됨</p>
          </div>
        </div>
        <div className="card">
          <p className="card-kicker">요약</p>
          <p>
            분기 운영 지표를 항목별로 점검하고 있습니다. 세부 수치는 확정 전이며,
            검토 완료 후 최종본을 공유할 예정입니다.
          </p>
          <dl className="dl">
            <dt>진행률</dt><dd>{progress}%</dd>
            <dt>담당</dt><dd>운영팀</dd>
            <dt>상태</dt><dd>검토 중</dd>
          </dl>
          <p className="card-meta">Esc 를 누르면 이전 화면으로 돌아갑니다.</p>
        </div>
      </div>
    );
  }

  if (!quiz.length) {
    return (
      <div className="container">
        <div className="card"><p className="card-meta">항목을 불러오는 중…</p></div>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="page-head">
        <div>
          <p className="kicker">운영 점검</p>
          <h1 className="page-title">리그 자료 검토</h1>
          <p className="page-sub">
            항목 {done ? quiz.length : idx + 1} / {quiz.length} · 처리율 {progress}%
            {' · '}Esc 로 화면 전환
          </p>
        </div>
      </div>

      <div className="progress" aria-label={`처리율 ${progress}%`}>
        {/* 채움은 width 가 아니라 transform — 0%면 -100%, 60%면 -40%(globals.css .progress > span). */}
        <span style={{ transform: `translateX(${progress - 100}%)` }} />
      </div>

      {done ? (
        <div className="stack-6">
          <div className="card">
            <p className="card-kicker">검토 결과</p>
            <h2 className="card-title">{grade.title}</h2>
            <p>{grade.body}</p>
            <dl className="dl">
              <dt>정답</dt><dd>{correct} / {quiz.length}</dd>
              <dt>정답률</dt><dd>{Math.round((correct / quiz.length) * 100)}%</dd>
            </dl>
            <div className="btn-row">
              <button type="button" className="btn btn-primary" onClick={reset}>
                <RotateCcw size={16} aria-hidden="true" /> 새 항목으로 다시
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setHidden(true)}>
                <FileText size={16} aria-hidden="true" /> 보고서 화면
              </button>
            </div>
          </div>

          <div className="card">
            <p className="card-kicker">오늘 확인한 항목</p>
            <ul className="list">
              {quiz.map((q) => (
                <li key={q.id} className="list-row">
                  <span className="text-muted">{q.question}</span>
                  {' — '}
                  <strong>{q.choices[q.answer]}</strong>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : current ? (
        <div className="card">
          <p className="card-kicker">{LEVEL_LABEL[current.difficulty]} · {current.label}</p>
          <h2 className="card-title">{current.question}</h2>

          <ul className="list">
            {current.shuffled.map((c, i) => {
              const isAnswer = i === current.shuffledAnswer;
              const isPicked = picked === i;
              // 정답을 고르기 전에는 아무 힌트도 주지 않는다.
              const tag = picked === null ? null
                : isAnswer ? <span className="tag tag-success">정답</span>
                : isPicked ? <span className="tag tag-danger">오답</span>
                : null;
              return (
                <li key={c} className="list-row">
                  <button
                    type="button"
                    className="btn btn-ghost btn-block"
                    disabled={picked !== null}
                    onClick={() => choose(i)}
                  >
                    {c}
                  </button>
                  {tag}
                </li>
              );
            })}
          </ul>

          {picked !== null && (
            <>
              <p className="card-meta">
                {picked === current.shuffledAnswer
                  ? <><CircleCheck size={14} aria-hidden="true" /> 맞았습니다. </>
                  : <><CircleX size={14} aria-hidden="true" /> 아쉽네요. </>}
                {current.explain}
              </p>
              <div className="btn-row">
                <button type="button" className="btn btn-primary" onClick={next}>
                  {idx + 1 >= quiz.length ? '검토 마치기' : '다음 항목'}
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
