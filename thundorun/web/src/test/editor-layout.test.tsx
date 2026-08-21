/**
 * editor-layout.test.tsx — `/run` 이미지 편집기 레이아웃 계약.
 *
 * 두 가지 증상을 고정한다(2026-08-20 사용자 스크린샷 지적):
 *   ② 하단 탭이 브라우저 하단 바·홈 인디케이터와 겹쳤다 → 세이프에어리어 여백
 *   ③ 사이즈 탭에서 비율을 바꾼 뒤 배경제거로 들어가면 **크롭 테두리 크기가 바뀌었다**
 *      → 도구 패널이 `maxHeight` 라 탭마다 높이가 달라졌고, 그만큼 작업공간(flex:1)이 변했으며,
 *        프레임이 작업공간의 `calc(100% - 80px)` 이라 함께 흔들렸다
 *
 * jsdom 은 레이아웃을 계산하지 않으므로 픽셀이 아니라 **계약**(어떤 스타일·클래스를 쓰기로 했는지)을
 * 검사한다. 픽셀 검증은 로그인이 필요한 `/run` 실화면에서만 가능하다.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import TabBar from '@/components/TabBar';

const WEB_ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(WEB_ROOT, rel), 'utf8');
const GLOBALS = read('src/app/globals.css');
const RUN_PAGE = read('src/app/run/page.tsx');

describe('② 하단 탭 — 브라우저 하단 UI와 겹치지 않는다', () => {
  it('TabBar 가 세이프에어리어 하단 여백을 적용한다', () => {
    const { container } = render(<TabBar activeTab="size" onTabChange={() => {}} />);
    const bar = container.querySelector('.tabs');
    expect(bar, '.tabs 루트가 없다').not.toBeNull();
    expect(
      bar!.className,
      'pb-safe 가 없다 — iOS 하단 바·홈 인디케이터에 탭이 가린다',
    ).toContain('pb-safe');
  });

  it('pb-safe 가 실제로 정의돼 있다 (클래스만 붙이고 규칙이 없으면 무의미)', () => {
    expect(GLOBALS).toMatch(/\.pb-safe\s*\{[^}]*padding-bottom:\s*env\(safe-area-inset-bottom\)/);
  });

  it('터치 기기에서 탭 높이가 44px 이상이다', () => {
    const block = GLOBALS.match(/@media \(pointer: coarse\)[\s\S]*?\n\}/);
    expect(block, 'coarse 포인터 블록이 없다').not.toBeNull();
    expect(block![0], '.tab 이 44px 규칙에 빠져 있다').toMatch(/\.tab\s*\{[^}]*min-height:\s*44px/);
    // ⚠ `display: inline-flex` 를 요구하면 안 된다 — 버튼은 기본이 inline-block 이라 min-height 가
    //    그냥 먹고, inline-flex 로 바꾸면 아이콘+글자 탭이 46.69 → 44px 로 오히려 줄었다(실측).
    expect(block![0], 'inline-flex 는 아이콘 탭을 오히려 줄인다').not.toMatch(
      /\.tab\s*\{[^}]*display:\s*inline-flex/,
    );
  });

  it('탭 5개가 모두 렌더된다 (여백을 넣다 항목이 사라지면 안 된다)', () => {
    const { container } = render(<TabBar activeTab="size" onTabChange={() => {}} />);
    expect(container.querySelectorAll('.tab')).toHaveLength(5);
  });

  it('선택된 탭이 aria-selected 로 표시된다', () => {
    const { container } = render(<TabBar activeTab="background" onTabChange={() => {}} />);
    const selected = container.querySelectorAll('[aria-selected="true"]');
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toContain('배경');
  });
});

describe('③ 크롭 테두리 — 탭을 바꿔도 크기가 변하지 않는다', () => {
  it('도구 패널 높이가 탭 내용이 아니라 뷰포트에만 의존한다', () => {
    /**
     * `maxHeight` 면 내용이 짧은 탭에서 패널이 줄고, 그만큼 작업공간이 늘어난다.
     * 프레임은 작업공간의 백분율이라 그대로 따라 변한다 — 그게 "테두리 크기가 바뀐다"의 정체다.
     */
    expect(
      RUN_PAGE,
      '도구 패널이 maxHeight 로 돌아갔다 — 탭마다 높이가 달라져 크롭 프레임이 흔들린다',
    ).not.toMatch(/className="scroll-y"[^>]*maxHeight/);
    /**
     * 높이는 **뷰포트에만** 의존해야 한다. 탭 내용에 의존하면 프레임이 흔들리고(원래 버그),
     * 픽셀로 못 박으면 폰에서 작업공간이 뭉개진다(100dvh 가 아이폰 13 에서도 664px 뿐).
     * clamp 로 상·하한을 두고 vh 에 비례시키는 게 두 조건을 동시에 만족하는 유일한 형태다.
     */
    expect(RUN_PAGE, '패널 높이가 뷰포트 기준 clamp 가 아니다').toMatch(
      /className="scroll-y"\s+style=\{\{\s*height:\s*'clamp\([^']*vh[^']*\)'/,
    );
  });

  it('패널이 flex 로 늘어나지 않는다 (flex: none)', () => {
    // 높이를 고정해도 flex 컨테이너 안에서 늘어나면 의미가 없다.
    expect(RUN_PAGE).toMatch(/className="scroll-y"[^>]*flex:\s*'none'/);
  });

  it('탭바가 세로로 눌리지 않는다 (짧은 화면에서 사라지던 것)', () => {
    // flex 열에서 기본 flex-shrink:1 이면 공간이 모자랄 때 탭바까지 찌그러진다.
    // 실측: 폰 가로(높이 320px)에서 탭바가 1px 까지 붕괴했다.
    expect(GLOBALS, '.tabs 가 압축 대상에서 빠지지 않았다').toMatch(/\.tabs\s*\{[^}]*flex:\s*none/);
  });

  it('썸네일 줄도 눌리지 않는다', () => {
    expect(read('src/components/LayerList.tsx')).toMatch(/flex:\s*'none'/);
  });

  it('패널이 세로 스크롤을 가진다 (내용이 넘쳐도 잘리지 않게)', () => {
    expect(GLOBALS).toMatch(/\.scroll-y\s*\{[^}]*overflow-y:\s*auto/);
  });
});

describe('편집기 골격 — 고칠 때 함께 깨지기 쉬운 것들', () => {
  it('루트가 100dvh 고정 높이를 유지한다', () => {
    // 이 높이가 흔들리면 작업공간·프레임이 전부 따라 흔들린다.
    expect(RUN_PAGE).toMatch(/height:\s*'100dvh'/);
  });

  it('크롭 프레임이 작업공간 기준 백분율로 잡힌다', () => {
    const canvas = read('src/components/LayerCanvas.tsx');
    expect(canvas).toMatch(/calc\(100% - \$\{pad \* 2\}px\)/);
  });
});
