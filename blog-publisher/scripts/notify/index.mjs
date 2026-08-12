/**
 * notify/index.mjs — Telegram + Discord 이중 발송 진입점
 * §D6: 두 채널 병렬 발송. 한쪽 실패해도 다른 쪽은 계속.
 * 사용: import { notify } from './notify/index.mjs'
 *       await notify('SUCCESS', { url, status, sha })
 */

import { sendTelegram } from './telegram.mjs';
import { sendDiscord }  from './discord.mjs';
import { makeLogger }   from '../lib/log.mjs';

const log = makeLogger('notify');

/** §D6 이벤트 타입 열거 */
export const EVENTS = Object.freeze({
  RUN_START:        'RUN_START',
  BUDGET_PREEMPT:   'BUDGET_PREEMPT',
  SUCCESS:          'SUCCESS',
  PARTIAL:          'PARTIAL',
  PUBLISH_FAIL:     'PUBLISH_FAIL',
  ROLLBACK:         'ROLLBACK',
  DISCARD_MAXRETRY: 'DISCARD_MAXRETRY',
  KILL_ACTIVE:      'KILL_ACTIVE',
  BUDGET_KILL:      'BUDGET_KILL',
  MISSED_RUN:       'MISSED_RUN',
  TRIPWIRE:         'TRIPWIRE',
  CROSSPUB_PENDING: 'CROSSPUB_PENDING',
  CROSSPUB_SESSION_EXPIRED: 'CROSSPUB_SESSION_EXPIRED',
  // 일일 영속화(git push) 실패 — 2026-07-23 신설.
  // 이전에는 `|| echo "push 실패"` 로 gitignore 된 runs/*.log 에만 남아
  // origin/main 이 9일간 정지한 걸 아무도 몰랐다. 이제 채널로 드러낸다.
  GIT_PERSIST_FAIL: 'GIT_PERSIST_FAIL',
  // 의도된 일시정지는 실패와 다른 이벤트로 분리한다 — 배포 기간 내내 빨간 "push 실패"가
  // 매일 울리면 채널이 무시당하고, 무시당한 경보는 gitignore 된 경보와 구별되지 않는다.
  GIT_PERSIST_PAUSED: 'GIT_PERSIST_PAUSED',
});

/**
 * notify(event, payload) → { telegram, discord }
 * payload: { url?, status?, sha?, reason?, budget?, details? } — 외부사실만
 * 두 채널 병렬 발송. 에러는 기록 후 계속.
 */
export async function notify(event, payload = {}) {
  const results = await Promise.allSettled([
    sendTelegram(event, payload),
    sendDiscord(event, payload),
  ]);

  const [tg, dc] = results;

  if (tg.status === 'rejected') {
    log.error('Telegram 발송 실패', tg.reason);
  }
  if (dc.status === 'rejected') {
    log.error('Discord 발송 실패', dc.reason);
  }

  // 'ok' 로 뭉개지 않는다 — 크리덴셜 폴백·mock 도 fulfilled 라, 예전 계약은
  // "아무데도 안 갔는데 ok" 를 반환했다. 그러면 검증이 또 자기확인이 된다(2026-07-23 리뷰).
  const status = (s) => (s.status !== 'fulfilled' ? 'error' : (s.value?.delivery ?? 'sent'));

  return { telegram: status(tg), discord: status(dc) };
}

// CLI 직접 실행 (테스트용)
if (process.argv[1] && process.argv[1].endsWith('index.mjs')) {
  const event   = process.argv[2] || 'RUN_START';
  const payload = { url: 'https://example.com', status: 200, sha: 'abc1234', details: 'CLI 테스트' };
  notify(event, payload).then(r => {
    console.log('알림 결과:', r);
  });
}
