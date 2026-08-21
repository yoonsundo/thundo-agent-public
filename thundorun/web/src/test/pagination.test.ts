/**
 * pagination.test.ts — 페이지 번호 창 계산.
 *
 * 영상 107편(24개씩 5쪽)처럼 쪽수가 늘어도 번호가 한 줄에 들어와야 한다.
 * 블로그처럼 전체를 나열하면 모바일에서 번호가 화면을 덮는다.
 */
import { describe, it, expect } from 'vitest';
import { pageWindow } from '@/lib/pagination';

describe('페이지 번호 창', () => {
  it('적으면 전부 보여준다', () => {
    expect(pageWindow(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageWindow(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('많으면 처음·끝·현재 주변만 낸다', () => {
    expect(pageWindow(1, 20)).toEqual([1, 2, 3, null, 20]);
    expect(pageWindow(10, 20)).toEqual([1, null, 8, 9, 10, 11, 12, null, 20]);
    expect(pageWindow(20, 20)).toEqual([1, null, 18, 19, 20]);
  });

  it('첫 쪽·끝 쪽은 항상 들어간다 — 어디서든 처음/끝으로 갈 수 있어야 한다', () => {
    for (const cur of [1, 5, 12, 20]) {
      const w = pageWindow(cur, 20);
      expect(w[0]).toBe(1);
      expect(w[w.length - 1]).toBe(20);
    }
  });

  it('현재 쪽은 언제나 포함된다', () => {
    for (const cur of [1, 2, 9, 15, 20]) {
      expect(pageWindow(cur, 20)).toContain(cur);
    }
  });

  it('생략 표시는 실제로 건너뛴 자리에만 넣는다', () => {
    // 1,2,3 다음이 20 이면 사이가 비었으므로 생략이 필요하다.
    expect(pageWindow(2, 20).filter((n) => n === null)).toHaveLength(1);
    // 붙어 있으면 생략을 넣지 않는다(…만 덩그러니 뜨는 걸 막는다).
    expect(pageWindow(4, 8).filter((n) => n === null)).toHaveLength(1);
    expect(pageWindow(1, 7).filter((n) => n === null)).toHaveLength(0);
  });

  it('번호가 중복되거나 순서가 어긋나지 않는다', () => {
    const w = pageWindow(10, 30).filter((n): n is number => n !== null);
    expect(new Set(w).size).toBe(w.length);
    expect([...w].sort((a, b) => a - b)).toEqual(w);
  });

  it('실제 영상 쪽수(107편 24개씩=5쪽)에서는 생략이 생기지 않는다', () => {
    expect(pageWindow(1, 5)).toEqual([1, 2, 3, 4, 5]);
  });
});
