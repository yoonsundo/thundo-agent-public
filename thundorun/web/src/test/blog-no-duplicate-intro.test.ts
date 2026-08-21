/**
 * blog-no-duplicate-intro.test.ts — 블로그 상세에서 도입부가 두 번 나오지 않는다.
 *
 * 배경(2026-08-19 라이브 실측):
 *   글 맨 위 요약 상자가 `post.description` 을 그대로 그렸는데, 그 값이 **본문 첫 문단을
 *   잘라 만든 것**이라 화면에서 같은 문장이 연속으로 두 번 나왔다. 표본 5편 전부 중복이었다.
 *   독자는 방금 읽은 문장을 다시 읽게 되고 도입부 길이가 두 배가 된다. 사용자 결정으로 상자를 제거했다.
 *
 * 왜 테스트로 잠그나:
 *   "요약 콜아웃을 넣자"는 자연스러운 아이디어라 누군가 다시 넣기 쉽다. 다시 넣으려면
 *   **description 을 첫 문단과 다르게 생성하는 것이 선행**돼야 한다는 사실을 여기서 상기시킨다.
 *
 * ⚠ 함께 지키는 것: `description` 자체는 살아 있어야 한다. 화면에서만 뺀 것이지
 *    metadata·OpenGraph·JSON-LD 는 계속 이 값을 쓴다. 지우면 검색 노출이 망가진다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const PAGE = path.resolve(
  __dirname,
  '../app/(site)/blog/[slug]/page.tsx',
);
const src = fs.readFileSync(PAGE, 'utf8');

/** 주석을 지운 실제 코드 — 설명 문구가 검사에 걸리면 안 된다. */
const code = src
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
  .replace(/\/\*[\s\S]*?\*\//g, ' ');

describe('블로그 상세 — 도입부 중복 방지', () => {
  it('본문 위에 description 을 그대로 그리는 요약 상자가 없다', () => {
    // `<aside aria-label="요약">` 형태의 콜아웃이 되살아나면 걸린다.
    expect(code, '요약 aside 가 다시 들어왔다').not.toMatch(/aria-label="요약"/);
    // 클래스명이 바뀌어도 잡히도록 "description 을 단독으로 렌더" 패턴도 본다.
    expect(
      code,
      'description 을 본문 밖에서 그대로 렌더하고 있다 — 첫 문단과 중복된다',
    ).not.toMatch(/>\s*\{post\.description\}\s*</);
  });

  it('description 은 메타데이터에 그대로 살아 있다 (SEO 회귀 방지)', () => {
    // 화면에서 뺐다고 값까지 지우면 검색 결과·공유 카드 설명이 사라진다.
    expect(code, 'metadata 의 description 이 사라졌다').toMatch(/description[,:]/);
    expect(code, 'JSON-LD 의 description 이 사라졌다').toMatch(
      /description:\s*post\.description/,
    );
  });

  it('"이 글의 순서"(목차)는 유지된다 — 함께 지워지면 안 된다', () => {
    // 요약 상자와 목차가 같은 `.card-outline` 을 써서 한꺼번에 지우기 쉽다.
    expect(code, '목차가 함께 사라졌다').toMatch(/aria-label="이 글의 순서"/);
  });
});
