/**
 * editorGeometry.ts — `/run` 이미지 편집기의 좌표 계산.
 *
 * 왜 컴포넌트 밖으로 뺐나:
 *   이 계산이 틀려서 "사진을 오른쪽으로 못 옮기는" 버그가 났다(2026-08-20 사용자 지적).
 *   컴포넌트 안에 있으면 브라우저를 띄워야만 검증이 되는데, `/run` 은 로그인 뒤에 있어
 *   자동 검증이 어렵다. 순수 함수로 빼면 숫자로 확정 검증할 수 있다.
 *
 * 좌표계 (중요):
 *   레이어의 `x`/`y` 는 **작업공간(workspace)** 왼쪽 위 기준이다. 작업공간은 어두운 영역 전체이고,
 *   그 안에 **크롭 프레임**(저장될 영역)이 가운데 떠 있다. 사진은 프레임 밖으로도 옮길 수 있어야 하며
 *   저장할 때 프레임 안쪽만 잘려 나간다.
 *
 *   ⚠ 그러므로 이동 한계는 **작업공간** 크기로 재야 한다. 프레임 크기로 재면
 *      프레임이 작업공간보다 좁은 만큼 오른쪽·아래로 못 가게 된다 — 그게 이 버그였다.
 */

/** 레이어가 완전히 사라지지 않도록 남겨 두는 최소 가시 픽셀. */
export const MIN_VISIBLE_PX = 30;

/** 내부 전용 — 외부에서 이 타입을 직접 쓸 일이 없다(호출부는 객체 리터럴을 넘긴다). */
interface ClampMoveInput {
  /** 옮기려는 위치(작업공간 좌표) */
  x: number;
  y: number;
  /** 레이어 크기 */
  width: number;
  height: number;
  /** 작업공간 크기 — 프레임 크기가 아니다 */
  workspaceWidth: number;
  workspaceHeight: number;
}

/**
 * 레이어 위치를 작업공간 안에 붙잡아 둔다.
 *
 * 규칙은 "완전히 놓치지 않게" 하나뿐이다 — 어느 방향으로 밀어도 최소 30px 은 작업공간 안에 남는다.
 * 프레임 밖으로 나가는 것 자체는 정상 동작이다(저장 영역 밖으로 밀어 두는 편집이 가능해야 한다).
 *
 * 작업공간 크기를 못 재는 경우(초기 렌더 등)에는 가두지 않는다 — 0 으로 재면 사진이
 * 왼쪽 위 구석에 붙어 버려서, 못 재는 것보다 나쁘다.
 */
export function clampLayerMove(input: ClampMoveInput): { x: number; y: number } {
  const { x, y, width, height, workspaceWidth, workspaceHeight } = input;

  const clampAxis = (value: number, size: number, workspace: number) => {
    if (!Number.isFinite(workspace) || workspace <= 0) return value;   // 못 재면 가두지 않는다
    const min = -size + MIN_VISIBLE_PX;      // 왼쪽/위로 밀어도 30px 은 남는다
    const max = workspace - MIN_VISIBLE_PX;  // 오른쪽/아래도 마찬가지
    // 하한이 상한을 넘는 경우(작업공간 + 레이어 크기 < 60px). 거의 안 일어나지만
    // 일어나면 Math.min/max 조합이 값을 엉뚱한 쪽으로 튕긴다 — 그때는 그냥 두는 편이 안전하다.
    if (min > max) return value;
    return Math.min(max, Math.max(min, value));
  };

  return {
    x: clampAxis(x, width, workspaceWidth),
    y: clampAxis(y, height, workspaceHeight),
  };
}

/** 리사이즈 최소 크기 — 손잡이를 다시 잡을 수 있어야 한다. */
export const MIN_LAYER_SIZE = 30;

/** 리사이즈 결과를 최소 크기 아래로 내려가지 않게 한다. */
export function clampLayerResize(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.max(MIN_LAYER_SIZE, width),
    height: Math.max(MIN_LAYER_SIZE, height),
  };
}
