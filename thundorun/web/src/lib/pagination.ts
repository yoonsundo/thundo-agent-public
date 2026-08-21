/**
 * lib/pagination.ts — 페이지 번호 창(window) 계산.
 *
 * 왜 별도 모듈인가: Next.js 의 page.tsx 는 정해진 export(default·metadata 등) 외에는 허용하지
 * 않는다. 페이지 안에 두면 타입 검사에서 막히고, 그렇다고 인라인으로 두면 테스트할 수 없다.
 */

/**
 * 표시할 페이지 번호 — 항상 처음·끝·현재 주변만 낸다.
 * 블로그(/blog)는 전체 번호를 다 나열하는데, 영상은 107편이라 그대로 두면 번호가 여러 줄이 된다.
 * @returns 번호 배열. `null` 은 건너뛴 구간(생략 표시) 자리다.
 */
export function pageWindow(current: number, total: number, span = 2): (number | null)[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const keep = new Set<number>([1, total]);
  for (let n = current - span; n <= current + span; n++) if (n >= 1 && n <= total) keep.add(n);
  const sorted = [...keep].sort((a, b) => a - b);
  const out: (number | null)[] = [];
  let prev = 0;
  for (const n of sorted) {
    if (prev && n - prev > 1) out.push(null);
    out.push(n);
    prev = n;
  }
  return out;
}
