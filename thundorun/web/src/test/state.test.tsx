/**
 * state.test.tsx — 상태 3종 컴포넌트 계약 (DESIGN.md §4.14 / §6).
 * 어떤 데이터 화면도 로딩·빈·에러를 빼먹지 않게 하는 공용 부품이라 계약을 고정한다.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Empty from '@/components/state/Empty';
import ErrorState from '@/components/state/ErrorState';
import Loading from '@/components/state/Loading';
import { SkeletonLine, TableSkeleton, CardSkeleton } from '@/components/state/Skeleton';

describe('Empty — 빈 상태', () => {
  it('.empty 골격과 주 액션 1개를 렌더한다', () => {
    const { container } = render(
      <Empty
        title="아직 발행된 글이 없습니다"
        body="첫 글을 발행하면 목록이 채워집니다."
        action={<button className="btn btn-primary">글 쓰기</button>}
      />,
    );
    expect(container.querySelector('.empty')).toBeTruthy();
    expect(container.querySelector('.empty-mark')).toBeTruthy();
    expect(container.querySelector('.empty-title')?.textContent).toBe('아직 발행된 글이 없습니다');
    expect(container.querySelector('.empty-body')).toBeTruthy();
    // 주 액션은 하나만 (규칙: 다음 행동을 하나만 제시)
    expect(container.querySelectorAll('.btn-primary')).toHaveLength(1);
  });

  it('본문·액션 없이도 깨지지 않는다', () => {
    const { container } = render(<Empty title="결과 없음" />);
    expect(container.querySelector('.empty-body')).toBeNull();
    expect(container.querySelector('.empty-title')?.textContent).toBe('결과 없음');
  });
});

describe('ErrorState — 에러 상태', () => {
  it('.banner[data-tone=danger] + role=alert + 재시도 수단을 제공한다', async () => {
    const onRetry = vi.fn();
    const { container } = render(
      <ErrorState title="불러오지 못했습니다 (500)" detail="잠시 후 다시 시도해 주세요." requestId="req_abc123" onRetry={onRetry} />,
    );
    const banner = container.querySelector('.banner');
    expect(banner).toBeTruthy();
    expect(banner?.getAttribute('data-tone')).toBe('danger');
    expect(screen.getByRole('alert')).toBeTruthy();
    // 요청 ID 는 식별자이므로 .text-mono
    expect(container.querySelector('.text-mono')?.textContent).toBe('req_abc123');

    await userEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('onRetry 가 없으면 재시도 버튼을 만들지 않는다', () => {
    render(<ErrorState detail="권한이 없습니다." />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('Loading / Skeleton — 로딩 상태', () => {
  it('Loading 은 .spinner + role=status(aria-live) 로 알린다', () => {
    const { container } = render(<Loading />);
    expect(container.querySelector('.spinner')).toBeTruthy();
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
  });

  it('SkeletonLine 은 .skeleton .skeleton-line 을 유지한다', () => {
    const { container } = render(<SkeletonLine width={88} />);
    const el = container.querySelector('.skeleton');
    expect(el?.classList.contains('skeleton-line')).toBe(true);
  });

  it('TableSkeleton 은 완성 화면과 같은 열 수의 골격을 만든다', () => {
    const { container } = render(
      <table className="table">
        <TableSkeleton cols={4} rows={3} />
      </table>,
    );
    expect(container.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(container.querySelectorAll('tbody tr:first-child td')).toHaveLength(4);
    expect(container.querySelectorAll('.skeleton-line')).toHaveLength(12);
  });

  it('CardSkeleton 은 .card 골격을 개수만큼 만든다', () => {
    const { container } = render(<CardSkeleton count={2} />);
    expect(container.querySelectorAll('.card')).toHaveLength(2);
    expect(container.querySelectorAll('.skeleton-title')).toHaveLength(2);
  });
});
