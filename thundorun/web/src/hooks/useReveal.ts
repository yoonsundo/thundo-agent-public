'use client';

import { useEffect } from 'react';

/**
 * 스크롤 진입 애니메이션 — `.reveal` 요소가 뷰포트에 들어오면 `.is-in` 을 붙인다.
 *
 * 왜 관찰자만으로는 안 되는가:
 *   IntersectionObserver 는 "교차 상태가 **바뀔 때**"만 콜백을 준다. 앵커 이동이나 스크롤 위치
 *   복원처럼 화면을 한 번에 건너뛰면, 중간 요소는 '아래에서 안 보임' → '위에서 안 보임' 으로
 *   상태가 그대로라 콜백이 아예 오지 않는다. 그러면 그 콘텐츠는 **투명한 채로 영원히 남는다**
 *   (시안 단계 390px 에서 실측: 아래로 점프 후 카드 1장이 계속 안 보임).
 *   그래서 관찰자 + 스크롤 훑기 + 타임아웃 안전망 세 겹으로 막는다.
 *
 * 모션은 장식이고 콘텐츠는 필수다 — 장식이 실패해서 내용이 사라지면 안 된다.
 */
export function useReveal(deps: readonly unknown[] = []) {
  useEffect(() => {
    const targets = Array.from(document.querySelectorAll<HTMLElement>('.reveal:not(.is-in)'));
    if (targets.length === 0) return;

    const showAll = () => targets.forEach((el) => el.classList.add('is-in'));

    // 기기 설정에서 '움직임 줄이기'를 켰으면 애니메이션 없이 즉시 보여준다.
    // ⚠ `matchMedia` 는 있다고 가정하면 안 된다 — jsdom 등 일부 환경엔 없어서 그대로 터진다(실측).
    //    모션은 장식이므로, 판단이 불가능하면 "애니메이션 없이 그냥 보여주기"로 안전하게 떨어진다.
    const reduce =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : true;

    if (reduce || typeof IntersectionObserver === 'undefined') {
      showAll();
      return;
    }

    const show = (el: HTMLElement, delayMs: number) => {
      el.style.transitionDelay = `${delayMs}ms`;
      el.classList.add('is-in');
    };

    // 스태거는 30~80ms 구간(60ms). 같은 화면에 동시에 들어온 것끼리만 계단을 준다.
    const io = new IntersectionObserver(
      (entries) => {
        entries
          .filter((e) => e.isIntersecting)
          .forEach((e, i) => {
            show(e.target as HTMLElement, Math.min(i, 4) * 60);
            io.unobserve(e.target);
          });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.05 },
    );
    targets.forEach((el) => io.observe(el));

    // 스크롤 훑기 — 관찰자가 못 깨우는 '건너뛴' 요소를 직접 처리한다.
    let pending = targets.slice();
    let ticking = false;
    const sweep = () => {
      ticking = false;
      const vh = window.innerHeight || document.documentElement.clientHeight;
      pending = pending.filter((el) => {
        if (el.classList.contains('is-in')) return false;
        if (el.getBoundingClientRect().top < vh) {
          show(el, 0);
          return false;
        }
        return true;
      });
      if (pending.length === 0) {
        window.removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', onScroll);
      }
    };
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(sweep); // 스크롤마다 레이아웃을 읽지 않게 프레임당 1회로 묶는다
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);

    // 최종 안전망 — 어떤 이유로든 안 깨어난 게 있으면 3초 뒤 전부 드러낸다.
    const safety = window.setTimeout(showAll, 3000);

    return () => {
      io.disconnect();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      window.clearTimeout(safety);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
