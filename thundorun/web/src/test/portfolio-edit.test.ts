/**
 * portfolio-edit.test.ts — 포트폴리오 미리보기 2 수정 경로의 두 계약 고정.
 *
 * 1) mergeCategory 가 detail 의 나머지 키를 보존한다 — 이게 깨지면 카테고리 한 번 바꿀 때마다
 *    요약·진행흐름·관점문단·기술노트가 통째로 날아간다.
 * 2) toEditPayload 가 빈 문자열을 null 로 눕히고 목록을 정리한다.
 */
import { describe, expect, it } from 'vitest';
import { mergeCategory } from '@/server/projects';
import { toEditPayload, type ProjectEditPayload } from '@/components/PortfolioProjectEditor';

describe('mergeCategory — detail 보존', () => {
  it('기존 detail 의 다른 키를 그대로 두고 category 만 바꾼다', () => {
    const detail = {
      summary: '요약',
      flow: [{ label: '수집', desc: '설명' }],
      personas: { hr: 'a', field: 'b', ceo: 'c' },
      tech: ['노트1'],
      category: 'personal',
    };
    expect(mergeCategory(detail, 'career')).toEqual({ ...detail, category: 'career' });
  });

  it('detail 이 없던 행이면 category 만 든 객체를 만든다', () => {
    expect(mergeCategory(null, 'career')).toEqual({ category: 'career' });
    expect(mergeCategory(undefined, 'personal')).toEqual({ category: 'personal' });
  });

  it('detail 자리에 배열·문자열이 와도 덮어쓰지 않고 새 객체를 만든다', () => {
    expect(mergeCategory(['x'], 'career')).toEqual({ category: 'career' });
    expect(mergeCategory('망가진 값', 'career')).toEqual({ category: 'career' });
  });
});

describe('toEditPayload — 저장 전 정리', () => {
  const base: ProjectEditPayload = {
    id: 'p1', title: '  제목  ', period: '2026', role: '   ',
    stack: [' TypeScript ', '', ' Next '], description: '설명',
    highlights: ['  a  ', '', 'b'], link: '  ',
    sort_order: 10, pinned: false, category: 'career',
  };

  it('빈 역할·링크를 null 로 눕힌다', () => {
    const out = toEditPayload(base);
    expect(out.role).toBeNull();
    expect(out.link).toBeNull();
  });

  it('제목을 다듬고 목록의 빈 항목을 걸러낸다', () => {
    const out = toEditPayload(base);
    expect(out.title).toBe('제목');
    expect(out.stack).toEqual(['TypeScript', 'Next']);
    expect(out.highlights).toEqual(['a', 'b']);
  });

  it('분류·정렬순서·고정 값은 그대로 전달한다', () => {
    const out = toEditPayload(base);
    expect(out.category).toBe('career');
    expect(out.sort_order).toBe(10);
    expect(out.pinned).toBe(false);
  });
});
