/**
 * editor-geometry.test.ts — `/run` 이미지 편집기 좌표 계산 계약.
 *
 * 왜 이 테스트가 중요한가:
 *   `/run` 은 로그인 뒤에 있어 브라우저 자동 검증이 어렵다. 그래서 이 계산이 틀렸을 때
 *   아무도 못 잡았고, 사용자가 직접 "사진이 오른쪽으로 안 간다"고 스크린샷으로 알려줘야 했다.
 *   좌표 규칙을 숫자로 고정해 같은 일이 반복되지 않게 한다.
 *
 * 버그의 정체(2026-08-20):
 *   레이어 좌표는 **작업공간**(어두운 영역 전체) 기준인데, 이동 한계를 **크롭 프레임**
 *   (가운데 떠 있는 저장 영역) 크기로 쟀다. 프레임이 훨씬 좁아 오른쪽·아래로 막혔다.
 */
import { describe, it, expect } from 'vitest';
import {
  clampLayerMove,
  clampLayerResize,
  MIN_VISIBLE_PX,
  MIN_LAYER_SIZE,
} from '@/lib/editorGeometry';

/** 스크린샷과 같은 상황: 폰 가로에 세로 프레임이 가운데 떠 있는 배치. */
const WORKSPACE = { workspaceWidth: 900, workspaceHeight: 600 };
const LAYER = { width: 200, height: 300 };

describe('레이어 이동 — 작업공간 기준으로 가둔다', () => {
  it('오른쪽으로 작업공간 끝까지 갈 수 있다 (이번 버그의 핵심)', () => {
    // 프레임이 400px 이라 예전 코드는 x 를 370 에서 막았다. 작업공간은 900 이므로 800 은 정상 위치다.
    const r = clampLayerMove({ x: 800, y: 0, ...LAYER, ...WORKSPACE });
    expect(r.x, '작업공간 안인데도 막히면 사진을 오른쪽으로 못 옮긴다').toBe(800);
  });

  it('아래로도 작업공간 끝까지 갈 수 있다', () => {
    const r = clampLayerMove({ x: 0, y: 550, ...LAYER, ...WORKSPACE });
    expect(r.y).toBe(550);
  });

  it('오른쪽 끝을 넘으면 최소 가시 폭만 남기고 멈춘다', () => {
    const r = clampLayerMove({ x: 5000, y: 0, ...LAYER, ...WORKSPACE });
    expect(r.x).toBe(WORKSPACE.workspaceWidth - MIN_VISIBLE_PX); // 870
  });

  it('왼쪽 한계는 예전과 동일하다 — 최소 30px 은 남는다', () => {
    const r = clampLayerMove({ x: -5000, y: 0, ...LAYER, ...WORKSPACE });
    expect(r.x).toBe(-LAYER.width + MIN_VISIBLE_PX); // -170
  });

  it('위쪽 한계도 레이어 높이 기준이다', () => {
    const r = clampLayerMove({ x: 0, y: -5000, ...LAYER, ...WORKSPACE });
    expect(r.y).toBe(-LAYER.height + MIN_VISIBLE_PX); // -270
  });

  it('가운데 값은 그대로 통과한다', () => {
    const r = clampLayerMove({ x: 123, y: 45, ...LAYER, ...WORKSPACE });
    expect(r).toEqual({ x: 123, y: 45 });
  });
});

describe('레이어 이동 — 잴 수 없거나 비정상인 입력', () => {
  it('작업공간 크기를 못 재면(0) 가두지 않는다', () => {
    // 0 으로 가두면 사진이 왼쪽 위 구석에 붙어 버린다 — 못 재는 것보다 나쁘다.
    const r = clampLayerMove({ x: 700, y: 400, ...LAYER, workspaceWidth: 0, workspaceHeight: 0 });
    expect(r).toEqual({ x: 700, y: 400 });
  });

  it('작업공간 크기가 NaN 이어도 크래시 없이 그대로 둔다', () => {
    const r = clampLayerMove({ x: 50, y: 60, ...LAYER, workspaceWidth: NaN, workspaceHeight: NaN });
    expect(r).toEqual({ x: 50, y: 60 });
  });

  it('하한이 상한을 넘는 극단값에서 값을 튕기지 않는다', () => {
    /**
     * 역전 조건은 `-size + 30 > workspace - 30`, 즉 **작업공간 + 레이어 크기 < 60px**.
     * 현실에선 거의 없지만 분기를 실제로 타는 입력으로 검증한다(작업공간 10 · 레이어 20 → 합 30).
     * 가드가 없으면 Math.min/max 조합이 값을 엉뚱한 쪽으로 밀어낸다.
     */
    const r = clampLayerMove({
      x: 500, y: 500, width: 20, height: 20, workspaceWidth: 10, workspaceHeight: 10,
    });
    expect(r, '역전 구간에서는 입력을 그대로 둬야 한다').toEqual({ x: 500, y: 500 });
  });

  it('x 와 y 가 서로 독립적으로 계산된다', () => {
    // 한 축이 막혀도 다른 축은 자유로워야 한다 — 대각선 이동이 벽에 붙는 걸 막는다.
    const r = clampLayerMove({ x: 99999, y: 250, ...LAYER, ...WORKSPACE });
    expect(r.x).toBe(870);
    expect(r.y).toBe(250);
  });
});

describe('레이어 크기 조절', () => {
  it('최소 크기 아래로 내려가지 않는다', () => {
    expect(clampLayerResize(5, 5)).toEqual({ width: MIN_LAYER_SIZE, height: MIN_LAYER_SIZE });
  });

  it('음수로 끌어도 최소 크기를 지킨다 (손잡이를 반대로 넘겼을 때)', () => {
    expect(clampLayerResize(-500, -500)).toEqual({ width: 30, height: 30 });
  });

  it('정상 크기는 그대로 통과한다', () => {
    expect(clampLayerResize(640, 480)).toEqual({ width: 640, height: 480 });
  });
});

describe('회귀 방지 — 예전 버그를 재현하지 않는다', () => {
  it('프레임 크기를 넘겨도 프레임 기준으로 가두지 않는다', () => {
    /**
     * 예전 코드: `Math.min(프레임폭 - 30, x)`.
     * 프레임 400 · 작업공간 900 일 때 x=800 이 370 으로 깎였다.
     * 이 테스트는 그 깎임이 되살아나면 깨진다.
     */
    const FRAME_WIDTH = 400;
    const r = clampLayerMove({ x: 800, y: 0, ...LAYER, ...WORKSPACE });
    expect(r.x).toBeGreaterThan(FRAME_WIDTH);
  });
});
