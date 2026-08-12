#!/usr/bin/env node
/**
 * notify/git-persist-fail.mjs — 일일 영속화(git push) 상태를 알림 채널로 드러낸다.
 *
 * 왜 별도 스크립트인가: 셸(cron 래퍼)에서 호출해야 하는데 notify/index.mjs 의 CLI 진입점은
 * 페이로드가 하드코딩된 테스트용이라 임의 사유를 실을 수 없다.
 *
 * 배경: 2026-07-15~23, `git push origin HEAD:main` 이 대용량 파일(state/shorts-footage)
 * 때문에 매일 거부됐는데 실패가 `|| echo "push 실패(수동 확인)"` 로 runs/*.log 에만 남았고
 * 그 경로는 gitignore 라 9일간 무증상이었다. 그 사이 origin/main 은 20커밋 뒤처졌다.
 *
 * 두 상태를 **다른 이벤트로** 구분한다:
 *   실패(빨강)  — push 가 거부됨. 사람이 원인을 봐야 한다.
 *   일시정지(노랑) — 마커로 의도적으로 건너뜀. 배포 끝나면 마커를 지우면 된다.
 * 섞으면 배포 기간 내내 빨간 "실패"가 울려 채널이 무시당하고, 무시당한 경보는
 * gitignore 된 경보와 실질적으로 같아진다.
 *
 * 사용:
 *   node scripts/notify/git-persist-fail.mjs <branch> <reason...>
 *   node scripts/notify/git-persist-fail.mjs --paused <branch> <reason...>
 * 계약: 절대 throw 하지 않는다(알림 실패가 cron 을 죽이면 안 됨). 항상 exit 0.
 */

import { notify, EVENTS } from './index.mjs';

// 운영 경보다 — RUN_MODE 게이트를 넘어 실제로 사람에게 도달해야 한다.
// 이 박스는 .env 가 live 인데 GITHUB_TOKEN/VERCEL_TOKEN 누락으로 항상 mock 으로 내려가고,
// 그래서 notify() 로 나가는 모든 이벤트가 .mock-out/notify.log(gitignore) 에만 적혀 왔다.
// import 뒤에 세팅해도 된다 — forceLive() 가 모듈 로드 시점이 아니라 **호출 시점**에 읽는다.
process.env.NOTIFY_FORCE_LIVE = '1';

const argv = process.argv.slice(2);
const paused = argv[0] === '--paused';
const [branch = 'unknown', ...reasonParts] = paused ? argv.slice(1) : argv;
const reason = reasonParts.join(' ').trim() || '사유 미상';

// 로그 꼬리는 길 수 있어 잘라서 싣는다(알림 본문 가독성).
const details = reason.length > 400 ? `${reason.slice(0, 400)}…` : reason;

// 문자열 리터럴 대신 EVENTS 를 쓴다 — 저장소의 기존 패턴(run-lion.mjs)과 동일하고, 오타가 조용히 지나가지 않는다.
const event = paused ? EVENTS.GIT_PERSIST_PAUSED : EVENTS.GIT_PERSIST_FAIL;
const headline = paused
  ? `브랜치 ${branch} → push 의도적 일시정지 중`
  : `브랜치 ${branch} → origin/main push 실패`;

notify(event, { reason: headline, details })
  .then((r) => { console.log(`[git-persist-fail] ${event} 알림 결과:`, JSON.stringify(r)); })
  .catch((e) => { console.error('[git-persist-fail] 알림 자체 실패:', e?.message || e); })
  .finally(() => process.exit(0));
