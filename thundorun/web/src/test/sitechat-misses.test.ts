/**
 * sitechat-misses.test.ts — 방문자 입력 정규화(AC-16) 검증.
 * normalizeMissQuestion 은 순수 함수 — DB 없이 판정한다.
 */
import { describe, it, expect } from 'vitest';
import { normalizeMissQuestion } from '@/server/sitechatMisses';

describe('normalizeMissQuestion', () => {
  it('제어문자를 공백으로 치환한다', () => {
    expect(normalizeMissQuestion('질문\u0000\u001F중\u007F간')).toBe('질문 중 간');
  });

  it('연속 공백·개행·탭을 하나로 축약한다', () => {
    expect(normalizeMissQuestion('  에이전트   프로젝트는\n\t뭐야?  ')).toBe('에이전트 프로젝트는 뭐야?');
  });

  it('500자로 자른다', () => {
    expect(normalizeMissQuestion('가'.repeat(600))).toHaveLength(500);
  });

  it('빈 입력·공백만 입력은 빈 문자열', () => {
    expect(normalizeMissQuestion('')).toBe('');
    expect(normalizeMissQuestion('   \n\t ')).toBe('');
  });

  it('정상 한국어 질문은 그대로 통과한다', () => {
    expect(normalizeMissQuestion('경력은 뭐야?')).toBe('경력은 뭐야?');
  });
});
