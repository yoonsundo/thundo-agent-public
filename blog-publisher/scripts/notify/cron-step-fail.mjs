#!/usr/bin/env node
/**
 * notify/cron-step-fail.mjs — cron 체인의 단계 실패를 알림 채널로 드러낸다.
 *
 * 왜 필요한가: cron 은 `>/dev/null 2>&1` 로 등록되고 래퍼 로그(`runs/*.log`)는 gitignore 라,
 * 래퍼가 `exit 1` 로 끝나도 **아무도 모른다.** 이 저장소는 같은 이유로 push 실패를 9일간
 * 못 봤다(2026-07-15~23). rc 를 로그에 보존하는 것만으로는 절반이고, 나머지 절반은
 * "사람에게 도달하는가"다.
 *
 * `git-persist-fail.mjs` 와 형제지만 대상이 다르다 — 저쪽은 git push 상태 전용이고,
 * 이쪽은 임의 cron 체인의 실패 사유를 싣는다.
 *
 * 사용: node scripts/notify/cron-step-fail.mjs <체인이름> <최악rc> <사유...>
 * 계약: 절대 throw 하지 않는다(알림 실패가 cron 을 죽이면 안 됨). 항상 exit 0.
 */
import { notify, EVENTS } from './index.mjs';

// 운영 경보다 — RUN_MODE 게이트를 넘어야 한다. 이 박스는 .env 가 live 여도 크리덴셜 누락으로
// 항상 mock 으로 내려가고, 그러면 경보가 .mock-out/notify.log 에만 적힌다(live-override.mjs 참조).
process.env.NOTIFY_FORCE_LIVE = '1';

const [chain = 'unknown', rc = '?', ...reasonParts] = process.argv.slice(2);
const reason = reasonParts.join(' ').trim() || '사유 미상';
const details = reason.length > 400 ? `${reason.slice(0, 400)}…` : reason;

notify(EVENTS.TRIPWIRE, {
  reason: `cron 체인 ${chain} 실패 — 최악 종료코드 ${rc}`,
  details,
})
  // 'ok' 로 뭉개지 않는다 — 이 파일의 존재 이유가 "사람에게 도달했는가"라, 결과 객체를
  // 그대로 찍으면 실제 도달과 크리덴셜 부재 폴백이 로그에서 구분되지 않는다(2026-07-23 계약).
  .then((r) => {
    const sent = r && (r.telegram === 'sent' || r.discord === 'sent');
    const line = `[cron-step-fail] 알림 결과: ${JSON.stringify(r)}`;
    if (sent) console.log(line);
    else console.error(`${line} — ⚠ 어느 채널에도 도달하지 못했다(크리덴셜 확인 필요)`);
  })
  .catch((e) => { console.error('[cron-step-fail] 알림 자체 실패:', e?.message || e); })
  .finally(() => process.exit(0));
