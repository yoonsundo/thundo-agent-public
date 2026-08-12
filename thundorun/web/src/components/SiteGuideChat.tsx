'use client';

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

/** 답변 텍스트 블록 — 문단 또는 목록. 목록 항목은 본문 + 들여쓰기 상세줄. */
export type AnswerBlock =
  | { type: 'p'; text: string }
  | { type: 'ul'; items: Array<{ text: string; detail: string[] }> };

/**
 * 서버 답변(플레인 텍스트)을 렌더 블록으로 파싱.
 * 규칙: `- ` 시작 = 목록 항목, 들여쓰기 줄 = 직전 항목의 상세, 나머지 = 문단.
 * (siteGuide.ts 의 답변 포맷과 짝 — 마크다운 라이브러리 없이 가독성 확보)
 */
export function parseAnswerBlocks(content: string): AnswerBlock[] {
  const blocks: AnswerBlock[] = [];
  for (const rawLine of String(content ?? '').split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;

    const last = blocks[blocks.length - 1];
    if (/^- /.test(line)) {
      const item = { text: line.replace(/^- /, ''), detail: [] as string[] };
      if (last?.type === 'ul') last.items.push(item);
      else blocks.push({ type: 'ul', items: [item] });
    } else if (/^\s/.test(rawLine) && last?.type === 'ul' && last.items.length > 0) {
      last.items[last.items.length - 1].detail.push(line.trim());
    } else {
      blocks.push({ type: 'p', text: line.trim() });
    }
  }
  return blocks;
}

const STARTERS = [
  '이 홈페이지는 어떤 사이트인가요?',
  '대표 프로젝트 3개만 소개해줘',
  '경력은 뭐야?',
  '연락은 어디로 하면 되나요?',
];

function AssistantAnswer({ content }: { content: string }) {
  const blocks = parseAnswerBlocks(content);
  return (
    <div className="stack-2">
      {blocks.map((block, i) =>
        block.type === 'p' ? (
          <p key={i} className="card-body" style={{ margin: 0 }}>{block.text}</p>
        ) : (
          <div key={i} className="list">
            {block.items.map((item, j) => (
              <div key={j} className="list-row" style={{ alignItems: 'flex-start' }}>
                <span className="text-mono text-muted" aria-hidden>•</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="card-title">{item.text}</div>
                  {item.detail.map((d, k) => (
                    <div key={k} className="card-meta">{d}</div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ),
      )}
    </div>
  );
}

export default function SiteGuideChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: 'assistant',
      content: '홈페이지 소개, 기술 스택, 대표 프로젝트, 경력, 블로그, 연락 방법을 물어보면 공개된 정보 기준으로 바로 정리해드립니다.',
    },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 새 메시지·로딩 변화 시 대화 끝으로 스크롤 (첫 렌더는 제외 — 페이지 진입을 흔들지 않는다)
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages, loading]);

  async function ask(question: string) {
    const message = question.trim();
    if (!message || loading) return;

    setLoading(true);
    setError('');
    setMessages(prev => [...prev, { role: 'user', content: message }]);
    setInput('');

    try {
      const res = await fetch('/api/site-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || '답변을 불러오지 못했습니다.');
      }
      setMessages(prev => [...prev, { role: 'assistant', content: String(data.answer || '') }]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '알 수 없는 오류';
      setError(msg);
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: '지금은 답변을 만들지 못했습니다. 잠시 후 다시 시도하거나, 대표 프로젝트·기술 스택·연락처처럼 짧게 물어봐 주세요.',
      }]);
    } finally {
      setLoading(false);
      // 연속 질문이 자연스럽게 — 답변 후 입력창으로 포커스 복귀
      inputRef.current?.focus();
    }
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void ask(input);
  }

  /** Enter = 전송, Shift+Enter = 줄바꿈. 한글 IME 조합 중 Enter 는 무시(조합 확정 키). */
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== 'Enter' || e.shiftKey) return;
    if (e.nativeEvent.isComposing) return;
    e.preventDefault();
    void ask(input);
  }

  return (
    <section className="card stack" style={{ marginBottom: 'var(--space-5)' }}>
      <div className="stack">
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <div className="spacer">
            <h2 className="card-title">방문자 Q&A</h2>
            <p className="text-muted">이 홈페이지와 포트폴리오를 공개된 정보 기준으로 설명합니다.</p>
          </div>
          <span className="tag tag-info">Portfolio Guide</span>
        </div>

        <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--space-2)' }}>
          {STARTERS.map((starter) => (
            <button
              key={starter}
              type="button"
              className="btn btn-secondary btn-pill"
              onClick={() => void ask(starter)}
              disabled={loading}
            >
              {starter}
            </button>
          ))}
        </div>

        <div className="stack-2 qa-log">
          {messages.map((message, index) => (
            <div
              key={`${message.role}-${index}`}
              className={message.role === 'assistant' ? 'bubble bubble-agent' : 'bubble bubble-user'}
              style={{ maxWidth: 'min(100%, 720px)' }}
            >
              <strong className="card-meta" style={{ display: 'block', marginBottom: 'var(--space-1)' }}>
                {message.role === 'assistant' ? 'Guide' : 'You'}
              </strong>
              {message.role === 'assistant'
                ? <AssistantAnswer content={message.content} />
                : <span style={{ whiteSpace: 'pre-wrap' }}>{message.content}</span>}
            </div>
          ))}
          {loading && (
            <div className="bubble bubble-agent" style={{ maxWidth: 'min(100%, 720px)' }}>
              <span className="text-muted">답변 작성 중…</span>
            </div>
          )}
          <div ref={endRef} />
        </div>

        <form className="stack-2" onSubmit={submit}>
          <textarea
            ref={inputRef}
            className="input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="예: 이 홈페이지는 어떤 사람의 어떤 작업을 보여주나요?"
            rows={2}
            disabled={loading}
          />
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <span className={error ? 'field-error spacer' : 'field-hint spacer'}>
              {error || 'Enter 전송 · Shift+Enter 줄바꿈 — 공개된 정보만 근거로 답합니다.'}
            </span>
            <button className="btn btn-primary" type="submit" disabled={loading || !input.trim()}>
              {loading ? '답변 작성 중...' : '질문하기'}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
