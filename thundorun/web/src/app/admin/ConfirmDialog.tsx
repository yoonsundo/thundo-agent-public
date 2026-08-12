'use client';

/**
 * ConfirmDialog — 파괴적 액션 확인 모달. DESIGN.md §4.13 / §8.
 *
 * `window.confirm`/`window.prompt` 대체. ESC·배경 클릭으로 닫히고, 포커스는 다이얼로그
 * 안에 갇히며(Tab 순환) 닫힐 때 열었던 트리거로 되돌아간다. 추가 입력(거절 사유 등)은
 * children 으로 `.field` 를 넣어 쓴다.
 * 어드민 전용이라 `app/admin/` 에 둔다(공용 컴포넌트 소유권 충돌 방지).
 *
 * 포커스 관리는 `useDialogFocus` 로 뽑아 다른 다이얼로그 껍데기(OrchestratorConsole 의
 * 목록·대화 다이얼로그)와 공유한다 — 접근성 계약이 화면마다 갈라지지 않게.
 */
import { useEffect, useRef, useState } from 'react';

/** 포커스를 가둘 대상 — 비활성·tabindex=-1 은 제외한다. */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * 열려 있는 다이얼로그 루트 스택. 다이얼로그가 겹칠 때(대화 다이얼로그 위의 확인 다이얼로그)
 * 맨 위 하나만 ESC·Tab 을 처리해야 한다 — 안 그러면 아래쪽 트랩이 포커스를 빼앗는다.
 */
const dialogStack: HTMLElement[] = [];

/**
 * 다이얼로그 접근성 3종(§8) — ESC 로 닫기 · Tab 포커스 트랩 · 닫을 때 트리거로 포커스 복귀.
 *
 * 반환된 ref 를 `.dialog`(또는 그에 준하는 컨테이너)에 걸어라.
 * `initialFocusRef` 를 주면 그 요소로, 없으면 첫 포커서블로 초기 포커스를 옮긴다.
 * 이미 다이얼로그 안에 포커스가 있으면(자식의 `autoFocus`) 건드리지 않는다.
 */
export function useDialogFocus<T extends HTMLElement = HTMLDivElement>(
  onClose: () => void,
  initialFocusRef?: React.RefObject<HTMLElement | null>,
) {
  const rootRef = useRef<T | null>(null);
  // 트리거는 **첫 렌더 중에** 잡는다(useState 초기화 함수). 커밋 뒤(useEffect)에는 자식의
  // autoFocus 가 이미 포커스를 가져간 상태일 수 있어 복귀 대상을 놓친다.
  const [trigger] = useState<Element | null>(() =>
    typeof document === 'undefined' ? null : document.activeElement,
  );

  // 마운트 1회: 스택 등재 + 초기 포커스, 언마운트: 트리거로 복귀.
  useEffect(() => {
    const root = rootRef.current;
    if (root) dialogStack.push(root);
    if (root && !root.contains(document.activeElement)) {
      const target = initialFocusRef?.current
        ?? root.querySelector<HTMLElement>(FOCUSABLE);
      target?.focus();
    }
    return () => {
      if (root) {
        const i = dialogStack.lastIndexOf(root);
        if (i >= 0) dialogStack.splice(i, 1);
      }
      if (trigger instanceof HTMLElement && document.contains(trigger)) trigger.focus();
    };
    // 마운트/언마운트에만 돈다 — trigger 는 불변, initialFocusRef 는 ref 라 재실행이 필요 없다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ESC + Tab 순환. onClose 는 인라인 화살표가 흔해 매 렌더 재등록되지만 비용은 없다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const root = rootRef.current;
      // 겹친 다이얼로그 중 맨 위만 반응한다.
      if (!root || dialogStack[dialogStack.length - 1] !== root) return;

      if (e.key === 'Escape') { onClose(); return; }
      if (e.key !== 'Tab') return;

      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && root.contains(active);

      if (e.shiftKey && (!inside || active === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return rootRef;
}

export default function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel = '닫기',
  tone = 'danger',
  busy = false,
  confirmDisabled = false,
  width,
  onConfirm,
  onClose,
  children,
}: {
  title: string;
  body?: string;
  confirmLabel: string;
  /** 취소 버튼 문구 — 화면 문맥에 맞춰 '취소'/'닫기' 를 고른다. */
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
  busy?: boolean;
  /** 확인 버튼 비활성 조건(필수 입력 미완 등). busy 와 OR 로 묶인다. */
  confirmDisabled?: boolean;
  /** 기본 폭(460px)보다 넓혀야 할 때만. 치수라 인라인 style 로 둔다(§12.10). */
  width?: number;
  onConfirm: () => void;
  onClose: () => void;
  children?: React.ReactNode;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useDialogFocus<HTMLDivElement>(onClose, confirmRef);

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={width ? { width: `min(${width}px, 100%)` } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="dialog-title">{title}</span>
        {body && <p className="dialog-body">{body}</p>}
        {children}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={tone === 'danger' ? 'btn btn-danger' : 'btn btn-primary'}
            onClick={onConfirm}
            disabled={busy || confirmDisabled}
          >
            {busy && <span className="spinner" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
