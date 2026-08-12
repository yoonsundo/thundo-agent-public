/**
 * lib/publish-format.ts — 외부 발행 API(/api/publish) 입력 정규화 헬퍼.
 * slug 생성·description 자동 도출은 발행 파이프라인(blog-db.mjs)의 규약을 그대로 따른다.
 */

/**
 * slugify(input) — URL-safe 슬러그. 영소문자·숫자·하이픈만 남긴다(한글 등은 제거).
 * 우리 발행 슬러그 관례(예: "ai-automation-tools-...")와 일치. 만들 수 없으면 빈 문자열.
 */
export function slugify(input: string): string {
  return String(input)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120);
}

/**
 * deriveDescription(markdown) — 첫 본문 문단에서 ~160자 메타 설명 도출.
 * blog-db.mjs deriveDescription 이식(헤딩·구분선·이미지 줄 제외, 마크다운 기호 제거).
 */
export function deriveDescription(markdown: string): string {
  const para = markdown
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#') && !l.startsWith('---') && !l.startsWith('!['));
  if (!para) return '';
  const plain = para.replace(/[*_`>#[\]()!]/g, '').replace(/\s+/g, ' ').trim();
  return plain.length > 160 ? plain.slice(0, 157) + '…' : plain;
}

/** YYYY-MM-DD 형식 검사. */
export function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime());
}

/** 오늘(UTC) YYYY-MM-DD. */
export function todayISODate(now: Date): string {
  return now.toISOString().slice(0, 10);
}
