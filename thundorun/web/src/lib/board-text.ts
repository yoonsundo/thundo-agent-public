/**
 * lib/board-text.ts — 경영회의 텍스트 정리 (서버·클라이언트 공용, 순수함수)
 *
 * 🔴 **이 파일에 `'use client'` 를 붙이지 마라.**
 *
 * `splitHeadline` 은 원래 `components/BoardApprovalList.tsx` 안에 있었는데 그 파일은
 * `'use client'` 다. 서버 컴포넌트(`BoardMeeting`)가 거기서 이 함수를 가져다 쓰자
 * 빌드는 통과하고 **요청 시점에** 죽었다:
 *
 *   Attempted to call splitHeadline() from the server but splitHeadline is on the client.
 *
 * `'use client'` 모듈의 export 는 서버에서 보면 실제 함수가 아니라 **클라이언트 참조**다.
 * 컴포넌트로 렌더하거나 props 로 넘기는 것만 되고, 서버에서 호출하면 던진다.
 * 그래서 양쪽이 함께 쓰는 순수함수는 client 경계 **밖**에 둔다.
 */

/** 제목 자리에 들어갈 최대 길이. 넘으면 첫 문장만 떼어 쓰고 나머지는 본문으로 내린다. */
const TITLE_MAX = 60;

/**
 * 제목과 본문을 안전하게 가른다.
 *
 * ⚠ 화면은 **데이터가 길이 규칙을 지킨다고 믿지 않는다.** 실측(2026-08-21): 팀장이 change 에
 * 502자를 넣어 제목 자리가 통째로 문단이 됐다. 프롬프트로 "40자 이내"를 요구했지만, 그건
 * 지켜지길 바라는 것이지 보장이 아니다. 그래서 길면 여기서 첫 문장만 떼어 제목으로 쓰고
 * 나머지는 본문으로 내린다 — 어떤 길이가 와도 화면이 무너지지 않는다.
 */
export function splitHeadline(change: string | null, plan?: string | null): { title: string; body: string | null } {
  const text = String(change ?? '').trim();
  const rest = String(plan ?? '').trim();
  if (!text) return { title: '(내용 없음)', body: rest || null };
  if (text.length <= TITLE_MAX) return { title: text, body: rest || null };

  // 첫 문장(마침표·번호 표기 앞)까지를 제목으로. 그마저 길면 잘라 쓴다.
  // 마침표 / 번호 표기(원문자) / 줄표 중 먼저 나오는 곳에서 끊는다.
  const firstStop = text.search(/[.。]\s|[①-⑳]|\s—\s/);
  const head = firstStop > 0 ? text.slice(0, firstStop).trim() : text;
  const title = head.length <= TITLE_MAX ? head : `${head.slice(0, TITLE_MAX)}…`;
  const tail = text.slice(title.replace(/…$/, '').length).trim();
  return { title, body: [tail, rest].filter(Boolean).join('\n\n') || null };
}
