/**
 * AssistantMarkdown.tsx — 에이전트/AI 응답 마크다운 공용 렌더러.
 * AgentChat 에서 추출(2026-07-09) — 오케스트레이션 콘솔과 채팅이 같은 렌더를 공유한다.
 * 보안: rehype-raw 미사용 → raw HTML 은 react-markdown 이 이스케이프(텍스트로 표시).
 * dangerouslySetInnerHTML 없음.
 * 타이포는 키트 `.article` 클래스(DESIGN.md §11.3)에 맡긴다 — pre/code/a 는
 * 복사 버튼·새 탭 열기 같은 동작만 오버라이드하고 스타일 클래스는 뿌리지 않는다.
 */
'use client';

import { useState, Children, isValidElement } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// ─── 복사 버튼 ─────────────────────────────────────────────────────────────────
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <button type="button" onClick={handleCopy} className="btn btn-ghost btn-sm">
      {copied ? '복사됨' : '복사'}
    </button>
  );
}

// ─── 마크다운 렌더러 ───────────────────────────────────────────────────────────
export default function AssistantMarkdown({ content }: { content: string }) {
  return (
    <div className="article">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre({ children }) {
            // 복사 버튼용 텍스트 추출
            let codeText = '';
            const items = Children.toArray(children);
            const first = items[0];
            if (isValidElement<{ children?: React.ReactNode }>(first)) {
              const cc = first.props.children;
              if (typeof cc === 'string') codeText = cc;
              else if (Array.isArray(cc)) {
                codeText = cc.filter((c): c is string => typeof c === 'string').join('');
              }
            }
            return (
              <div className="stack-2">
                <div className="row-end">
                  <CopyButton text={codeText} />
                </div>
                <pre>{children}</pre>
              </div>
            );
          },
          a({ children, href }) {
            return (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
