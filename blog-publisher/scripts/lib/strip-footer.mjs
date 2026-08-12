/**
 * strip-footer.mjs — 작가 에이전트 자기보고 푸터 제거.
 *
 * 작가(beaver/fox/wolf)가 초안 본문 끝에 붙이는 진단 메타 보고 블록
 *   ---
 *   **음절 수**: 1847 …   **헤딩 수**: 4개 …   **저장 경로**: /…/draft-fox.draft.md
 * 또는
 *   ---
 *   **구체 증거**: …   **1인칭 경험**: …   **니치 키워드**: …   **출처 표기**: …
 * 이 발행 본문(blog_posts.content)으로 새어 사이트에 노출되는 것을 차단한다.
 *
 * 판정: 문서 "맨 끝" 구분선(--- 또는 <hr>) 뒤 블록에 아래 진단 키가 하나라도 있으면
 *       그 구분선부터 끝까지 제거한다. 본문 중간의 정상 '---'(주제 구분)과, 본문 안의
 *       정상 볼드 라벨(**출력**·**입력 예시**·**해결책** 등)은 건드리지 않는다.
 *       마크다운(**키**)과 HTML(<strong>키</strong>) 저장분을 모두 처리.
 */

// 발행 본문엔 절대 없어야 할 작가/게이트 진단 라벨(자기보고 전용).
const META_KEYS = [
  '음절 수', '추정 음절 수', '어절 수', '단어 수',
  '헤딩 수', '저장 경로', '작성 완료',
  '구체 증거', '1인칭 경험', '니치 키워드', '출처 표기', '출처 수',
];
const KEY_ALT = META_KEYS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const KEY_RE = new RegExp(`(?:\\*\\*(?:${KEY_ALT})\\*\\*|<strong>\\s*(?:${KEY_ALT})\\s*</strong>)`);
// 구분선: 마크다운 '---'(단독 줄) 또는 HTML '<hr>'.
const SEP_RE = /\n-{3,}[ \t]*(?=\n|$)|<hr\s*\/?>/gi;

/** 본문 맨 끝의 작가 자기보고 푸터를 제거. */
export function stripWriterFooter(body) {
  if (typeof body !== 'string' || !body) return body;
  const seps = [...body.matchAll(SEP_RE)];
  if (seps.length === 0) return body.trimEnd();
  const last = seps[seps.length - 1];
  const tail = body.slice(last.index);
  if (KEY_RE.test(tail)) return body.slice(0, last.index).trimEnd();
  return body.trimEnd();
}

/** 본문에 작가 진단 푸터가 있는지 여부(정리 필요 판단용). */
export function hasWriterFooter(body) {
  if (typeof body !== 'string' || !body) return false;
  const seps = [...body.matchAll(SEP_RE)];
  if (seps.length === 0) return false;
  return KEY_RE.test(body.slice(seps[seps.length - 1].index));
}
