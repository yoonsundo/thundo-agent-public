/**
 * editor-drag-wiring.test.tsx — 드래그가 **어느 크기를 기준으로 가두는가**를 지킨다.
 *
 * 왜 별도 파일인가:
 *   `editor-geometry.test.ts` 는 계산 함수만 검사한다. 그런데 원래 버그는 계산이 아니라
 *   **배선**이었다 — 좌표는 작업공간(workspaceRef) 기준인데 한계를 크롭 프레임(canvasAreaRef)
 *   크기로 넘겼다. 실제로 배선만 되돌려 보니 기존 테스트 199개가 **전부 통과**했다(2026-08-20 실증).
 *   즉 순수함수 테스트만으로는 이 버그의 재발을 못 막는다. 그 자리를 여기서 잡는다.
 *
 * jsdom 은 레이아웃을 계산하지 않으므로 `clientWidth` 와 `getBoundingClientRect` 를 직접 심어
 * "작업공간은 넓고 프레임은 좁은" 실제 상황을 만든다. 두 값이 다르기 때문에 어느 쪽을 참조하는지가
 * 결과로 드러난다.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import LayerCanvas from '@/components/LayerCanvas';
import type { Layer } from '@/types/editor';

/** 스크린샷과 같은 배치: 넓은 작업공간 가운데 좁은 세로 프레임. */
const WORKSPACE = { width: 900, height: 600 };
const FRAME = { width: 400, height: 560 };

function makeLayer(over: Partial<Layer> = {}): Layer {
  const img = document.createElement('img');
  return {
    id: 'L1', image: img, originalImage: img,
    x: 100, y: 100, width: 200, height: 300,
    bgRemoved: false, colorTint: null,
    brightness: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0,
    ...over,
  };
}

/** 요소에 레이아웃 수치를 심는다(jsdom 은 0 을 돌려준다). */
function stubBox(el: HTMLElement, box: { width: number; height: number }) {
  Object.defineProperty(el, 'clientWidth', { value: box.width, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: box.height, configurable: true });
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: box.width, bottom: box.height, ...box, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
}

function setup(layer: Layer) {
  const onUpdateLayer = vi.fn();
  const workspaceRef = { current: null as HTMLDivElement | null };
  const canvasAreaRef = { current: null as HTMLDivElement | null };

  const utils = render(
    <LayerCanvas
      layers={[layer]}
      selectedLayerId={layer.id}
      selectedPreset={1}          // 스토리(9:16) — 세로 프레임
      activeTab="size"
      eraserSize={20}
      canvasAreaRef={canvasAreaRef}
      workspaceRef={workspaceRef}
      onSelectLayer={() => {}}
      onUpdateLayer={onUpdateLayer}
      onAddFile={() => {}}
      onStartEraser={() => {}}
      onApplyEraser={() => {}}
    />,
  );

  // 작업공간은 넓게, 프레임은 좁게 — 두 값이 달라야 어느 쪽을 쓰는지 드러난다.
  if (workspaceRef.current) stubBox(workspaceRef.current, WORKSPACE);
  if (canvasAreaRef.current) stubBox(canvasAreaRef.current, FRAME);

  return { ...utils, onUpdateLayer };
}

/** 이미지를 잡고 (dx, dy) 만큼 끈다. */
function drag(container: HTMLElement, dx: number, dy: number) {
  const img = container.querySelector('img');
  expect(img, '레이어 이미지가 렌더되지 않았다').not.toBeNull();
  // setPointerCapture 는 jsdom 에 없다 — 드래그 시작이 여기서 죽으면 안 된다.
  (img as HTMLElement & { setPointerCapture?: unknown }).setPointerCapture = () => {};
  fireEvent.pointerDown(img!, { clientX: 0, clientY: 0, pointerId: 1 });
  const surface = container.firstElementChild as HTMLElement;
  fireEvent.pointerMove(surface, { clientX: dx, clientY: dy, pointerId: 1 });
}

beforeEach(() => vi.clearAllMocks());

describe('드래그 배선 — 한계는 작업공간 크기로 잰다', () => {
  it('프레임 폭을 넘어 오른쪽으로 옮길 수 있다 (원래 버그의 자리)', () => {
    const layer = makeLayer({ x: 100 });
    const { container, onUpdateLayer } = setup(layer);

    drag(container, 600, 0); // x: 100 → 700

    expect(onUpdateLayer, '이동 콜백이 호출되지 않았다').toHaveBeenCalled();
    const { x } = onUpdateLayer.mock.calls.at(-1)![1];
    expect(
      x,
      `x 가 ${FRAME.width}(프레임 폭) 근처에서 잘렸다 — 한계를 프레임 기준으로 재고 있다`,
    ).toBeGreaterThan(FRAME.width);
    expect(x).toBe(700);
  });

  it('작업공간 밖으로는 나가지 않는다 (최소 30px 가시)', () => {
    const layer = makeLayer({ x: 100 });
    const { container, onUpdateLayer } = setup(layer);

    drag(container, 5000, 0);

    const { x } = onUpdateLayer.mock.calls.at(-1)![1];
    expect(x).toBe(WORKSPACE.width - 30); // 870
  });

  it('세로도 작업공간 높이 기준이다 (프레임 높이가 아니라)', () => {
    const layer = makeLayer({ y: 100 });
    const { container, onUpdateLayer } = setup(layer);

    drag(container, 0, 5000);

    const { y } = onUpdateLayer.mock.calls.at(-1)![1];
    expect(y).toBe(WORKSPACE.height - 30); // 570
    expect(y, '프레임 높이로 가두면 530 에서 잘린다').toBeGreaterThan(FRAME.height - 30);
  });

  it('왼쪽 한계는 레이어 크기 기준으로 유지된다', () => {
    const layer = makeLayer({ x: 100, width: 200 });
    const { container, onUpdateLayer } = setup(layer);

    drag(container, -5000, 0);

    const { x } = onUpdateLayer.mock.calls.at(-1)![1];
    expect(x).toBe(-200 + 30); // -170
  });
});
