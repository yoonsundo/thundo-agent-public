/**
 * confirm-dialog.test.tsx — 확인 다이얼로그 접근성 계약(§4.13 · §8).
 *
 * 모달 접근성은 "구현했다"고 말하기 쉽고 썩기도 쉽다(ESC 만 있고 트랩은 없는 상태로
 * 오래 굳어 있었다). 그래서 ESC·배경클릭·초기포커스·Tab 트랩·포커스 복귀·중첩 우선순위를
 * 여기서 고정한다. 이 계약은 `OrchestratorConsole` 의 다이얼로그 껍데기도 같은 훅으로 공유한다.
 */
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConfirmDialog from '@/app/admin/ConfirmDialog';

/** 트리거 버튼 + 상태로 여닫는 다이얼로그 — 포커스 복귀를 검사하려면 실제 트리거가 필요하다. */
function Harness({ children }: { children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>열기</button>
      {open && (
        <ConfirmDialog
          title="삭제할까요?"
          body="복구할 수 없습니다."
          confirmLabel="삭제"
          onConfirm={() => setOpen(false)}
          onClose={() => setOpen(false)}
        >
          {children}
        </ConfirmDialog>
      )}
    </>
  );
}

describe('ConfirmDialog — 키트 구조 (§4.13)', () => {
  it('.dialog-backdrop + .dialog[role=dialog][aria-modal] 골격을 쓴다', () => {
    const { container } = render(
      <ConfirmDialog title="t" confirmLabel="확인" onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    const dialog = container.querySelector('.dialog-backdrop > .dialog')!;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('t');
  });

  it('tone 에 따라 확인 버튼이 .btn-danger / .btn-primary 로 갈린다', () => {
    const { rerender } = render(
      <ConfirmDialog title="t" confirmLabel="삭제" onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: '삭제' }).className).toContain('btn-danger');
    rerender(
      <ConfirmDialog title="t" confirmLabel="승인" tone="primary" onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: '승인' }).className).toContain('btn-primary');
  });
});

describe('ConfirmDialog — 접근성 (§8)', () => {
  it('ESC 로 닫힌다', async () => {
    const onClose = vi.fn();
    render(<ConfirmDialog title="t" confirmLabel="확인" onConfirm={vi.fn()} onClose={onClose} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('배경을 눌러도 닫히고, 다이얼로그 내부 클릭은 새지 않는다', async () => {
    const onClose = vi.fn();
    const { container } = render(
      <ConfirmDialog title="t" confirmLabel="확인" onConfirm={vi.fn()} onClose={onClose} />,
    );
    await userEvent.click(container.querySelector('.dialog')!);
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(container.querySelector('.dialog-backdrop')!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('열리면 확인 버튼으로 초기 포커스가 간다', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: '열기' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '삭제' }));
  });

  it('자식이 autoFocus 를 쓰면 초기 포커스를 빼앗지 않는다', async () => {
    render(
      <Harness>
        <textarea aria-label="사유" autoFocus />
      </Harness>,
    );
    await userEvent.click(screen.getByRole('button', { name: '열기' }));
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '사유' }));
  });

  it('Tab 이 배경으로 빠지지 않고 첫↔마지막을 순환한다', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: '열기' }));
    const cancel  = screen.getByRole('button', { name: '닫기' });
    const confirm = screen.getByRole('button', { name: '삭제' });

    // 마지막(확인)에서 Tab → 첫(닫기)으로 돌아온다. 트리거('열기')로 새지 않는다.
    expect(document.activeElement).toBe(confirm);
    await userEvent.tab();
    expect(document.activeElement).toBe(cancel);

    // 첫(닫기)에서 Shift+Tab → 마지막(확인).
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(confirm);
  });

  it('닫으면 열었던 트리거로 포커스가 복귀한다', async () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: '열기' });
    await userEvent.click(trigger);
    expect(document.activeElement).not.toBe(trigger);

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('다이얼로그가 겹치면 ESC 는 맨 위 하나만 닫는다', async () => {
    const outerClose = vi.fn();
    const innerClose = vi.fn();
    render(
      <>
        <ConfirmDialog title="바깥" confirmLabel="확인" onConfirm={vi.fn()} onClose={outerClose} />
        <ConfirmDialog title="위" confirmLabel="확인" onConfirm={vi.fn()} onClose={innerClose} />
      </>,
    );
    await userEvent.keyboard('{Escape}');
    expect(innerClose).toHaveBeenCalledTimes(1);
    expect(outerClose).not.toHaveBeenCalled();
  });
});
