'use client';

/**
 * ThemeToggle — 라이트/다크 전환. DESIGN.md §9.
 *
 * 이 컴포넌트만 `data-theme` 를 만진다. 다른 컴포넌트는 다크 분기를 만들지 않고
 * 토큰이 처리하게 둔다(design-guard 테스트가 이를 강제한다).
 *
 * 테마의 단일 진실은 React state 가 아니라 `<html data-theme>` 다(레이아웃의 인라인
 * 스크립트가 페인트 전에 먼저 쓴다). 그래서 state 로 복제하지 않고 useSyncExternalStore
 * 로 DOM 을 구독한다 — effect 안 setState 로 인한 연쇄 렌더도, 하이드레이션 불일치도 없다.
 */
import { useSyncExternalStore } from 'react';
import { Moon, Sun } from 'lucide-react';

type Theme = 'light' | 'dark';

/** data-theme 변경을 구독한다(다른 탭·다른 토글이 바꿔도 따라온다). */
function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

function getSnapshot(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

/** 서버 렌더는 키트 정본 기본값 — 레이아웃의 `data-theme="light"` 와 일치시킨다. */
function getServerSnapshot(): Theme {
  return 'light';
}

export default function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const isDark = theme === 'dark';

  const toggle = () => {
    const next: Theme = isDark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('theme', next);
    } catch {
      // 프라이빗 모드 등 저장 불가 — 전환 자체는 동작시킨다.
    }
  };

  return (
    <button
      type="button"
      className="btn btn-icon"
      onClick={toggle}
      aria-label={isDark ? '라이트 모드로 전환' : '다크 모드로 전환'}
      aria-pressed={isDark}
    >
      {isDark ? <Sun size={18} aria-hidden /> : <Moon size={18} aria-hidden />}
    </button>
  );
}
