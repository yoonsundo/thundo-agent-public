/**
 * slug.mjs — 발행 파일명에 쓰이는 slug 의 안전성 검증.
 *
 * 왜 필요한가(2026-08-19 감사): slug 는 **LLM 이 쓴 초안 frontmatter** 에서 그대로 읽어
 * `published/<날짜>-<slug>.md` 경로를 만들고 writeFileSync 한다. 초안은 Reddit/HN·웹 수집물을
 * 근거로 생성되므로 그 내용은 신뢰할 수 없는 입력이다. 검증이 없으면 `slug: ../../../../tmp/x`
 * 같은 값이 path.join 정규화를 타고 **레포 밖 임의 경로에 파일을 쓴다**(실측: ROOT/published 에서
 * /home/user/th-team/tmp/x.md 로 탈출). 확장자는 .md 로 고정되지만 CLAUDE.md·AGENTS.md 같은
 * 에이전트 지시 파일을 덮어쓰면 다음 런의 행동이 바뀌므로 실질 피해가 크다.
 *
 * 정책: 소문자 영숫자와 하이픈만. 경로 구분자·상위이동·공백·제어문자·유니코드 전부 거부.
 * (작가 계약이 요구하는 "영문 소문자 하이픈 슬러그"와 동일 — 정상 초안은 영향 없다.)
 */

/** 발행에 허용되는 slug 형식. 선두는 영숫자, 이후 영숫자·하이픈, 1~100자. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

/** isSafeSlug(s) → boolean. 순수. */
export function isSafeSlug(s) {
  return typeof s === 'string' && SLUG_RE.test(s);
}

/**
 * assertSafeSlug(s, ctx) → s (통과) | throw Error (거부)
 * 발행 직전 경로 조립부에서 호출한다. 거부 사유를 남기되 제어문자는 치환해 로그 위조를 막는다.
 */
export function assertSafeSlug(s, ctx = 'slug') {
  if (isSafeSlug(s)) return s;
  // eslint-disable-next-line no-control-regex
  const shown = String(s ?? '').replace(/[\u0000-\u001F\u007F]/g, '\u00b7').slice(0, 80);
  throw new Error(
    `${ctx} 형식 위반 — 발행 거부: "${shown}" (허용: 소문자 영숫자·하이픈 1~100자, 경로문자 금지)`
  );
}
