/**
 * blog-search.test.ts — 목록 검색을 DB 로 내린 뒤의 계약 고정.
 *
 * 배경: 예전엔 목록 페이지가 전 글 본문을 앱까지 끌어와(131편 4.44MB) JS 로 필터링했다.
 * 이제 본문 대조는 DB 가 하고 앱은 slug 집합만 받는다. 그 경계에서 쿼리를 안전하게 만드는
 * 순수함수가 toSearchPattern 이다 — 여기가 깨지면 검색이 조용히 전건/0건이 된다.
 */
import { describe, expect, it } from 'vitest';
import { toSearchPattern } from '@/lib/blog';

describe('toSearchPattern', () => {
  it('보통 검색어는 앞뒤 와일드카드를 붙인다', () => {
    expect(toSearchPattern('토큰')).toBe('*토큰*');
    expect(toSearchPattern('claude code')).toBe('*claude code*');
  });

  it('앞뒤 공백은 다듬는다', () => {
    expect(toSearchPattern('  자동화  ')).toBe('*자동화*');
  });

  it('빈 검색어는 null — 필터를 걸지 않는다는 신호', () => {
    expect(toSearchPattern('')).toBeNull();
    expect(toSearchPattern('   ')).toBeNull();
    expect(toSearchPattern(null as unknown as string)).toBeNull();
  });

  it('PostgREST or-필터를 깨뜨리는 문자를 제거한다', () => {
    // 쉼표·괄호·백슬래시는 필터 문법의 구분자
    expect(toSearchPattern('a,b')).toBe('*a b*');
    expect(toSearchPattern('(주)회사')).toBe('*주 회사*');
  });

  it('ILIKE 와일드카드(% _)는 이스케이프해 리터럴로 다룬다', () => {
    // 그대로 두면 검색어가 패턴이 된다 — 실측에서 `ll_` 이 58건이어야 할 자리에 119건을 냈다.
    expect(toSearchPattern('ll_')).toBe('*ll\\_*');
    expect(toSearchPattern('100%')).toBe('*100\\%*');
    expect(toSearchPattern('snake_case')).toBe('*snake\\_case*');
  });

  it('구분자만 있는 검색어는 null (빈 패턴으로 전건 매칭되지 않게)', () => {
    expect(toSearchPattern(',,,')).toBeNull();
    expect(toSearchPattern('()')).toBeNull();
  });
});
