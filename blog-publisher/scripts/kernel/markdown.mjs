/**
 * kernel/markdown.mjs — 발행물 텍스트 처리 (순수함수)
 *
 * 왜 있는가(F-06·F-09): 같은 처리가 게이트마다 복제돼 있었다.
 *   - `stripFrontmatter` — 15개 게이트에 **바이트 동일** 복제
 *   - `stripCode` — 4개 게이트(ai-tells·density·hedge·credibility). 코드만 제거
 *   - `stripCodeAndHtml` — check-length 1곳. **거기에 더해 HTML 태그까지 제거**
 *
 * 마지막 둘이 문제였다. 이름이 비슷해 같아 보이는데 의미가 달라서,
 * 삽화(`<figure>`·`<img>`)가 든 초안에서 **길이 게이트가 세는 본문과
 * 밀도·헤징 게이트가 세는 본문이 달랐다.** 여기서는 그 차이를 이름이 아니라
 * **옵션으로 명시**한다 — `stripBody(text, { html: true })`.
 *
 * 정규식은 원본 그대로다. 바꾸면 게이트 판정이 바뀐다.
 *
 * 커널 규약: fs·child_process·Date 를 import 하지 않는다.
 */

/**
 * YAML frontmatter 제거 후 본문 반환. 없으면 원문 그대로.
 * @param {string} text
 * @returns {string}
 */
export function stripFrontmatter(text) {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return m ? m[1] : text;
}

/**
 * 펜스드 코드블록(``` 또는 ~~~)과 인라인 코드(`…`) 제거.
 * HTML 태그는 **남긴다** — 그게 필요하면 stripHtml 이나 stripBody({html:true}).
 * @param {string} text
 * @returns {string}
 */
export function stripCode(text) {
  let t = text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm, '');
  t = t.replace(/`[^`\n]+`/g, '');
  return t;
}

/**
 * HTML 태그 제거(태그만, 내용은 남는다).
 * @param {string} text
 * @returns {string}
 */
export function stripHtml(text) {
  return text.replace(/<[^>]+>/g, '');
}

/**
 * 본문 정제. 각 단계를 켜고 끌 수 있다 — 어떤 게이트가 무엇을 세는지가
 * 호출부에 드러나게 하려는 것이 요점이다.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.frontmatter=true] frontmatter 제거
 * @param {boolean} [opts.code=true]        코드블록·인라인코드 제거
 * @param {boolean} [opts.html=false]       HTML 태그 제거 (check-length 계열만 true)
 * @returns {string}
 */
export function stripBody(text, { frontmatter = true, code = true, html = false } = {}) {
  let t = text;
  if (frontmatter) t = stripFrontmatter(t);
  if (code)        t = stripCode(t);
  if (html)        t = stripHtml(t);
  return t;
}

/**
 * 한글 음절 수 (U+AC00~U+D7A3). 길이 게이트의 판정 단위.
 * @param {string} text
 * @returns {number}
 */
export function countKoreanSyllables(text) {
  return [...text].filter(c => c >= '가' && c <= '힣').length;
}
