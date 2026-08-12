import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import projects from '@/server/projects.default.json';

const UNIVERSITY_PROJECTS = [
  ['incheon-university-information-system', '인천대학교 통합정보시스템', 50],
  ['chungcheong-university-information-system', '충청대학교 통합정보시스템', 60],
  ['duksung-womens-university-information-system', '덕성여자대학교 통합정보시스템', 70],
  ['jangan-university-information-system', '장안대학교 통합정보시스템', 80],
] as const;

describe('대학교 통합정보시스템 기본 프로젝트', () => {
  it('대학별 고유 항목 4개를 정해진 순서로 제공한다', () => {
    const universityProjects = projects.filter((project) =>
      project.id.endsWith('-university-information-system'),
    );

    expect(
      universityProjects.map(({ id, title, sort_order }) => [id, title, sort_order]),
    ).toEqual(UNIVERSITY_PROJECTS);
  });

  it('기존 합산 항목을 기본 데이터에 남기지 않는다', () => {
    expect(projects.some(({ id }) => id === 'university-enterprise-backend')).toBe(false);
  });

  it('인천대 경력은 검증된 행정·운영 범위를 구체적으로 보여준다', () => {
    const incheon = projects.find(({ id }) => id === 'incheon-university-information-system');

    expect(incheon).toMatchObject({
      period: '2019.05 ~ 2024.05',
      role: '행정 시스템 백엔드 개발 · Oracle 최적화 · 운영/보안/배포',
    });
    expect(incheon?.description).toContain('예산·회계·구매·자산·시설·총무');
    expect(incheon?.description).toContain('기존 업무 규칙과 운영 안정성');
    expect(incheon?.description).toContain('사용자 이슈 재현·수정·배포');
    expect(incheon?.description).toContain('보안 패치와 배포 관리');
    expect(incheon?.highlights).toHaveLength(6);
    expect(incheon?.highlights.every((item) => /^(build|note): /.test(item))).toBe(true);
  });

  it('나머지 대학은 기간을 추정하지 않고 검증된 구현·전환 경력만 적는다', () => {
    const scoped = projects.filter(({ id }) => [
      'chungcheong-university-information-system',
      'duksung-womens-university-information-system',
      'jangan-university-information-system',
    ].includes(id));

    expect(scoped).toHaveLength(3);
    for (const project of scoped) {
      expect(project.period).toBe('');
      expect(project.description).toContain('학사·부속 시스템');
      expect(project.description).toContain('업무 로직');
      expect(project.description).toContain('시스템 전환 작업');
      expect(`${project.description} ${project.highlights.join(' ')}`).not.toMatch(/이관|성과|리드|설계|규모/);
    }
    expect(new Set(scoped.map(({ description }) => description)).size).toBe(3);
  });

  it('Supabase 갱신 SQL도 대학별 항목을 upsert하고 기존 합산 항목을 제거한다', () => {
    const sql = readFileSync(join(process.cwd(), 'supabase', 'portfolio_refresh.sql'), 'utf8');

    for (const [id, title] of UNIVERSITY_PROJECTS) {
      expect(sql).toContain(`'${id}'`);
      expect(sql).toContain(`'${title}'`);
    }
    expect(sql).toContain("where id = 'university-enterprise-backend';");
  });
});
