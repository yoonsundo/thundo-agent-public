/**
 * site-guide-chat-format.test.ts — 챗봇 답변 파서(parseAnswerBlocks) 고정.
 * siteGuide.ts 의 답변 포맷(`- 항목` + 들여쓰기 상세줄)과 짝이다 — 포맷이 바뀌면 여기가 먼저 깨져야 한다.
 */
import { describe, it, expect } from 'vitest';
import { parseAnswerBlocks } from '@/components/SiteGuideChat';

describe('parseAnswerBlocks', () => {
  it('경력 연혁 포맷(항목+들여쓰기 상세)을 목록 블록으로 파싱한다', () => {
    const answer = 'Thundo의 경력 연혁입니다(최신순).\n- 2024.06 ~ 현재 · AI 연구소 RAG 시스템\n  Elasticsearch 인프라 구축\n- 2019.05 ~ 2024.05 · 인천대학교 통합정보시스템\n  행정 업무 개발·운영';
    const blocks = parseAnswerBlocks(answer);
    expect(blocks).toEqual([
      { type: 'p', text: 'Thundo의 경력 연혁입니다(최신순).' },
      {
        type: 'ul',
        items: [
          { text: '2024.06 ~ 현재 · AI 연구소 RAG 시스템', detail: ['Elasticsearch 인프라 구축'] },
          { text: '2019.05 ~ 2024.05 · 인천대학교 통합정보시스템', detail: ['행정 업무 개발·운영'] },
        ],
      },
    ]);
  });

  it('목록 없는 답변은 문단 블록만 만든다', () => {
    expect(parseAnswerBlocks('한 줄 답변입니다.')).toEqual([
      { type: 'p', text: '한 줄 답변입니다.' },
    ]);
  });

  it('빈 줄로 나뉜 문단을 각각의 블록으로 만든다', () => {
    const blocks = parseAnswerBlocks('첫 문단.\n\n둘째 문단.');
    expect(blocks).toEqual([
      { type: 'p', text: '첫 문단.' },
      { type: 'p', text: '둘째 문단.' },
    ]);
  });

  it('연락처 포맷(- 라벨: 링크)도 목록으로 파싱한다', () => {
    const blocks = parseAnswerBlocks('연락 창구는 프로필 링크에 정리돼 있습니다.\n- GitHub: https://github.com/\n- Email: mailto:a@b.c');
    expect(blocks[1]).toEqual({
      type: 'ul',
      items: [
        { text: 'GitHub: https://github.com/', detail: [] },
        { text: 'Email: mailto:a@b.c', detail: [] },
      ],
    });
  });

  it('빈 입력·null 은 빈 배열', () => {
    expect(parseAnswerBlocks('')).toEqual([]);
    expect(parseAnswerBlocks(null as unknown as string)).toEqual([]);
  });
});
