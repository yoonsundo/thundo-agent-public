/**
 * theme.test.tsx — 테마 전환 계약 (DESIGN.md §9).
 * "토글만으로 전환된다 / 컴포넌트에 다크 분기를 만들지 않는다" 를 보장하는 지점.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ThemeToggle from '@/components/ui/ThemeToggle';
import { THEME_INIT_SCRIPT } from '@/lib/theme';

beforeEach(() => {
  document.documentElement.setAttribute('data-theme', 'light');
  localStorage.clear();
});

describe('ThemeToggle', () => {
  it('아이콘 전용 버튼이므로 aria-label 을 가진다 (§8)', () => {
    render(<ThemeToggle />);
    expect(screen.getByRole('button', { name: '다크 모드로 전환' })).toBeTruthy();
  });

  it('클릭하면 html[data-theme] 와 localStorage 가 함께 바뀐다', async () => {
    render(<ThemeToggle />);
    await userEvent.click(screen.getByRole('button'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('theme')).toBe('dark');

    await userEvent.click(screen.getByRole('button', { name: '라이트 모드로 전환' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem('theme')).toBe('light');
  });

  it('현재 테마를 aria-pressed 로 노출한다', async () => {
    render(<ThemeToggle />);
    const btn = screen.getByRole('button');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    await userEvent.click(btn);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });

  it('키트 버튼 클래스만 쓴다 (새 스타일 정의 금지)', () => {
    const { container } = render(<ThemeToggle />);
    expect(container.querySelector('button')?.className).toBe('btn btn-icon');
  });
});

describe('THEME_INIT_SCRIPT — FOUC 방지', () => {
  it('저장된 dark 를 페인트 전에 복원한다', () => {
    localStorage.setItem('theme', 'dark');
    // 레이아웃이 <head> 에 넣는 스크립트와 동일한 코드를 실행한다.
    new Function(THEME_INIT_SCRIPT)();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('저장값이 없으면 기본 light 를 건드리지 않는다', () => {
    new Function(THEME_INIT_SCRIPT)();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('오염된 저장값은 무시한다', () => {
    localStorage.setItem('theme', 'neon');
    new Function(THEME_INIT_SCRIPT)();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});
