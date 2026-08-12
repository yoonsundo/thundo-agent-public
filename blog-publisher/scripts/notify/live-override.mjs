/**
 * notify/live-override.mjs — 운영 경보를 RUN_MODE 게이트에서 빼내는 명시적 예외.
 *
 * 왜 필요한가 (2026-07-23 실측):
 * 이 박스의 `.env` 는 `RUN_MODE=live` 인데 `GITHUB_TOKEN`·`VERCEL_TOKEN` 이 없어
 * `detectRunMode()` 가 항상 mock 으로 내린다. 그 결과 `notify()` 로 나가는 **모든** 이벤트가
 * `.mock-out/notify.log`(gitignore) 에만 적히고 사람에게 도달한 적이 없다.
 * - `CROSSPUB_SESSION_EXPIRED` 가 2026-07-06 부터 17일간 안 울려 대기 36건이 쌓였다.
 * - `GIT_PERSIST_FAIL` 도 같은 운명이 될 뻔했다(이 파일이 그걸 막는다).
 *
 * 핵심 판단: `RUN_MODE` 는 **파이프라인을 시뮬레이션하는가**를 뜻하지,
 * **운영자에게 알릴 것인가**를 뜻하지 않는다. 두 개념이 한 스위치에 묶여 있던 게 버그다.
 *
 * 다만 전면 우회는 하지 않는다 — 테스트·mock 런이 실제 메시지를 쏘면 안 되므로
 * 호출자가 의도를 명시한 경우(NOTIFY_FORCE_LIVE=1)에만 예외를 연다.
 * 크리덴셜이 없으면 각 채널의 기존 폴백이 그대로 동작한다(이 파일은 그 경로를 안 건드린다).
 */

/** 운영 경보로서 mock 게이트를 넘을 것인가. 호출 시점의 env 를 읽는다(호출자가 직전에 세팅 가능). */
export function forceLive() {
  return process.env.NOTIFY_FORCE_LIVE === '1';
}
