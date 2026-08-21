/**
 * run-scope.test.ts — `/run`(이미지 편집기) 격리 계약을 테스트로 고정한다.
 *
 * 왜 이 테스트가 있나:
 *   사용자가 "도구함의 사진편집은 절대 건드리지 말 것"을 하드 제약으로 못박았다(2026-08-19).
 *   격리는 ①래퍼 레이아웃 ②globals.css 의 토큰 되돌림 ③동결 파일 무수정, 셋이 모두 성립해야 한다.
 *   셋 중 하나만 조용히 깨져도 편집기 조작감이 바뀌므로, 문서가 아니라 테스트로 잠근다(DESIGN.md §12.8).
 *
 * 왜 스크린샷이 아닌가:
 *   `/run` 은 미들웨어가 로그인을 요구한다(`middleware.ts:114`). 실화면 대조는 감사 계정이 있어야
 *   가능하고 CI 에서 재현하기 어렵다. 계약(래퍼·토큰·동결)은 소스 스캔으로 확정적으로 검사된다.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import RunScopeLayout from '@/app/run/layout';

const WEB_ROOT = path.resolve(__dirname, '../..');
const GLOBALS = fs.readFileSync(path.join(WEB_ROOT, 'src/app/globals.css'), 'utf8');

/** 개편에서 제외하기로 한 사진편집 파일들. 이 목록이 곧 사용자와의 약속이다. */
const FROZEN = [
  'src/app/run/page.tsx',
  'src/components/BackgroundRemoval.tsx',
  'src/components/ColorChange.tsx',
  'src/components/ColorCorrection.tsx',
  'src/components/EraserTool.tsx',
  'src/components/LayerCanvas.tsx',
  'src/components/LayerList.tsx',
  'src/components/SizeTool.tsx',
];

describe('/run 격리 — 래퍼', () => {
  it('레이아웃이 자식을 .run-scope 로 감싼다', () => {
    const { container } = render(<RunScopeLayout><span>편집기</span></RunScopeLayout>);
    const scope = container.querySelector('.run-scope');
    expect(scope, '.run-scope 래퍼가 없다 — 격리가 통째로 무효다').not.toBeNull();
    expect(scope!.textContent).toBe('편집기');
  });

  it('래퍼가 동결 파일이 아니라 별도 레이아웃 파일에 있다', () => {
    expect(fs.existsSync(path.join(WEB_ROOT, 'src/app/run/layout.tsx'))).toBe(true);
    // page.tsx 에 래퍼를 붙였다면 동결 약속이 깨진 것이다.
    const page = fs.readFileSync(path.join(WEB_ROOT, 'src/app/run/page.tsx'), 'utf8');
    expect(page.includes('run-scope'), '동결 파일 page.tsx 가 수정됐다').toBe(false);
  });
});

describe('/run 격리 — 토큰 되돌림', () => {
  it('.run-scope 가 레이아웃에 참여하지 않는다 (display: contents)', () => {
    // 편집기 최상위는 height:100dvh + flex 열이다. 래퍼가 박스를 만들면 높이 사슬이 끊긴다.
    expect(GLOBALS).toMatch(/\.run-scope\s*\{[^}]*display:\s*contents/);
  });

  it('.run-scope 안에서 모션 토큰이 무효값으로 되돌아간다', () => {
    const block = GLOBALS.match(/\.run-scope\s*\{[^}]*--dur-press[^}]*\}/);
    expect(block, '.run-scope 의 토큰 되돌림 블록이 없다').not.toBeNull();
    const css = block![0];
    for (const t of ['--dur-press', '--dur-tip', '--dur-menu', '--dur-panel']) {
      expect(css, `${t} 가 0ms 로 되돌아가지 않는다`).toMatch(new RegExp(`${t}:\\s*0ms`));
    }
    expect(css, '--press-scale 이 1 로 되돌아가지 않는다').toMatch(/--press-scale:\s*1\b/);
  });

  it('토큰이 아닌 신규 선언도 .run-scope 안에서 되돌아간다 (터치 44px)', () => {
    /**
     * 격리는 토큰만으로 성립하지 않는다. 치수·레이아웃처럼 토큰을 거치지 않는 선언은
     * `.run-scope` 를 그냥 통과한다. 실제로 터치 타깃 44px 규칙이 동결 편집기로 새어
     * `.btn-icon`(34×34px)을 34×44 비정사각형으로 만들었다(사후 리뷰 적발).
     * 이 테스트는 그 되돌림이 유지되는지 잠근다.
     */
    expect(
      GLOBALS,
      '터치 44px 가 .run-scope 안에서 되돌아가지 않는다 — 편집기 버튼이 찌그러진다',
    ).toMatch(/\.run-scope\s+\.btn[^{]*\{[^}]*min-height:\s*0/);
  });

  it('카드 표면 개편도 .run-scope 안에서 되돌아간다', () => {
    /**
     * `.card` 는 동결 8파일 중 5개에서 7번 쓰인다(BackgroundRemoval·ColorChange·
     * ColorCorrection·EraserTool·SizeTool). 카드를 흰색으로 띄우는 개편이 전역이라
     * 되돌리지 않으면 "건드리지 말라"고 한 편집기 화면이 그대로 바뀐다.
     * 토큰이 아니라 선언이라 스코프가 자동으로 막지 못한다 — 명시적 원복이 필요하다.
     */
    const block = GLOBALS.match(/\.run-scope\s+\.card\s*\{[^}]*\}/);
    expect(block, '.run-scope .card 원복 규칙이 없다 — 편집기 카드가 함께 바뀐다').not.toBeNull();
    expect(block![0], '표면색이 원래대로 돌아가지 않는다').toMatch(/background:\s*var\(--color-surface\)/);
    expect(block![0], '그림자가 남아 있다').toMatch(/box-shadow:\s*none/);
  });

  it(':root 에 되돌림 대상 토큰이 실제로 정의돼 있다', () => {
    for (const t of ['--ease-out', '--dur-press', '--press-scale']) {
      expect(GLOBALS, `${t} 가 :root 에 없다`).toMatch(new RegExp(`${t}:\\s*[^;]+;`));
    }
  });
});

describe('/run 격리 — 새 모션은 토큰으로만', () => {
  /**
   * 격리는 "값이 토큰을 거칠 때만" 성립한다. `transition: transform 160ms ease` 처럼
   * 값을 직접 박으면 `.run-scope` 가 손쓸 방법이 없다. 그래서 우리가 새로 넣은
   * 키트 규칙들이 토큰을 쓰는지 검사한다.
   */
  const MUST_USE_TOKENS: Array<[string, RegExp]> = [
    ['.btn 누름 배율', /\.btn:active:not\(:disabled\)\s*\{[^}]*scale\(var\(--press-scale\)\)/],
    ['.btn 전환', /\.btn\b[^{]*\{[^}]*transition:[^;]*var\(--dur-press\)[^;]*var\(--ease-out\)/],
    ['.dialog 전환', /\.dialog\s*\{[^}]*transition:[^;]*var\(--dur-panel\)/],
    ['.drawer 전환', /\.drawer\s*\{[^}]*transition:[^;]*var\(--dur-panel\)/],
  ];

  for (const [name, re] of MUST_USE_TOKENS) {
    it(`${name} 이 토큰을 쓴다`, () => {
      expect(GLOBALS, `${name} 이 토큰 대신 값을 직접 쓴다 — /run 격리가 뚫린다`).toMatch(re);
    });
  }
});

describe('/run 격리 — 동결 파일', () => {
  it('동결 8파일이 전부 존재한다 (경로가 바뀌면 이 테스트부터 깨져야 한다)', () => {
    const missing = FROZEN.filter((f) => !fs.existsSync(path.join(WEB_ROOT, f)));
    expect(missing, `동결 목록의 파일이 사라졌다: ${missing.join(', ')}`).toEqual([]);
  });
});
