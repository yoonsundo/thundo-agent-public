#!/usr/bin/env node
/**
 * recovery-wiring.test.mjs — 회복 계측이 **실제로 불리는가**.
 *
 * 🔴 이 저장소가 반복해서 당한 패턴이다: 도구를 만들어 놓고 어떤 스케줄러도 부르지 않는다.
 *    실측 전례 —
 *      · cohort-report·internal-links 가 문서에만 폐루프의 일부로 적힌 채 두 달간 미배선
 *      · internal-links 추천 589건의 소비처가 0
 *      · cron-step-fail 알림기를 만들어 두고 정작 매일 도는 일일 체인만 안 씀
 *    **만들어 놓고 안 부르면 없는 것과 같다.** 그래서 배선 자체를 테스트로 잠근다.
 *
 * ⚠ 파일 존재만 보지 않는다 — 존재는 하는데 아무도 안 부르는 것이 바로 그 실패 모드다.
 */
process.env.RUN_MODE = process.env.RUN_MODE || 'mock';
import { readFileSync, existsSync } from 'node:fs';

let passN = 0, failN = 0;
const ok = (n, c) => { if (c) { passN++; console.log(`  [PASS] ${n}`); } else { failN++; console.log(`  [FAIL] ${n}`); } };

const CRON = 'scripts/seo/seo-weekly-cron.sh';
const REPORT = 'scripts/seo/recovery-report.mjs';
const METRICS = 'scripts/seo/recovery-metrics.mjs';

ok('회복 리포트 스크립트가 있다', existsSync(REPORT));
ok('  └ 계산 모듈이 있다', existsSync(METRICS));

if (existsSync(CRON)) {
  const cron = readFileSync(CRON, 'utf8');
  ok('주간 체인이 회복 리포트를 부른다', /recovery-report\.mjs/.test(cron));
  /**
   * ⚠ `run_step` 을 거쳐야 실패가 `worst` 에 집계되고, 그래야 체인 끝에서 알림이 나간다.
   *    맨 `node ...` 로 부르면 실패해도 조용하다 — 이 저장소가 44일간 당한 그 모양이다.
   */
  ok('  └ run_step 으로 부른다(실패가 집계·알림된다)', /run_step\s+recovery\s+scripts\/seo\/recovery-report\.mjs/.test(cron));
} else {
  console.log('  ⏭ 주간 cron 파일 없음 — 건너뜀');
}

if (existsSync('package.json')) {
  const s = JSON.parse(readFileSync('package.json', 'utf8')).scripts ?? {};
  ok('사람이 직접 돌릴 수 있는 npm 스크립트가 있다', Object.values(s).some(v => /recovery-report\.mjs/.test(String(v))));
}

/**
 * 리포트가 지켜야 할 계약. 이 셋은 지표를 **잘못 읽게 만드는** 종류라 문구로 못 박는다.
 */
if (existsSync(REPORT)) {
  const src = readFileSync(REPORT, 'utf8');
  ok('구글·네이버 합산 금지를 명시한다', /합산.*금지|합산하지 않는다/.test(src));
  ok('  └ 분자·분모를 함께 싣는다(분모 축소 착시 방지)', /분자|분모/.test(src));
  ok('  └ 측정 못 함과 0 을 구분한다', /측정 못 함|측정불가|수집조차/.test(src));
}

console.log(`\n회복 계측 배선: ${passN} pass / ${failN} fail`);
process.exit(failN ? 1 : 0);
