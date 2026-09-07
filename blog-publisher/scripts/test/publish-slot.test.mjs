#!/usr/bin/env node
/**
 * publish-slot.test.mjs — 발행 슬롯 판정.
 *
 * 🔴 주 3편(월·수·금) 상한이 지금까지 **런북 프롬프트에만** 있었다. 런북은 `claude -p` 에
 *    들어가는 지시문이라 지켜지길 바라는 것이지 보장이 아니다. 같은 저장소의 카드뉴스는
 *    이 교훈을 먼저 배웠다 — 인스타에 삭제 API 가 없어 `slot.daily_cap` 을 코드가 강제한다.
 *
 * ⚠ 이 모듈은 **차단하지 않는다.** 실제 방어선은 사람 승인 관문이고(과잉분은 `ready` 로만
 *    쌓인다), 여기서 막으면 백필·재적재 같은 정당한 경로까지 죽는다. 판정만 내리고
 *    호출부가 기록·경고에 쓴다.
 */
process.env.RUN_MODE = process.env.RUN_MODE || 'mock';
const { checkSlot, weekStart, kstWeekdayIso, PUBLISH_WEEKDAYS, WEEKLY_CAP } =
  await import('../lib/publish-slot.mjs');

let passN = 0, failN = 0;
const ok = (n, c) => { if (c) { passN++; console.log(`  [PASS] ${n}`); } else { failN++; console.log(`  [FAIL] ${n}`); } };
const eq = (n, a, b) => ok(`${n}${a === b ? '' : ` — got ${JSON.stringify(a)} want ${JSON.stringify(b)}`}`, a === b);

// 2026-09-07 은 월요일. UTC 03:00 = KST 12:00 이라 경계에서 안전하다.
const at = (iso) => new Date(`${iso}T03:00:00Z`);

eq('발행 요일은 월·수·금', PUBLISH_WEEKDAYS.join(','), '1,3,5');
eq('  └ 상한은 발행 요일 수와 같다(하루 1편)', WEEKLY_CAP, PUBLISH_WEEKDAYS.length);

eq('월요일 = ISO 1', kstWeekdayIso(at('2026-09-07')), 1);
eq('  └ 일요일 = ISO 7(0 이 아니다)', kstWeekdayIso(at('2026-09-13')), 7);

/**
 * ⚠ 주 경계는 ISO-8601(월~일)이다. 일요일을 주의 시작으로 잡으면 금요일 발행분이
 *    다음 주로 넘어가 상한이 사실상 두 배가 된다.
 */
eq('주 시작은 그 주 월요일', weekStart(at('2026-09-09')), '2026-09-07');
eq('  └ 일요일도 같은 주에 속한다', weekStart(at('2026-09-13')), '2026-09-07');
eq('  └ 다음 월요일은 새 주', weekStart(at('2026-09-14')), '2026-09-14');

{
  const r = checkSlot(at('2026-09-07'), []);
  ok('발행 요일 + 여유 있으면 허용', r.allowed);
  eq('  └ 사용량을 보고한다', r.usedThisWeek, 0);
}
ok('발행 요일이 아니면 거부', !checkSlot(at('2026-09-08'), []).allowed);
ok('  └ 왜인지 말한다', /발행 요일이 아니다/.test(checkSlot(at('2026-09-08'), []).reason));

{
  const week = ['2026-09-07', '2026-09-09', '2026-09-11'];
  const r = checkSlot(at('2026-09-11'), week);
  ok('주간 상한에 도달하면 거부', !r.allowed);
  ok('  └ 몇 편 썼는지 말한다', /3\/3/.test(r.reason));
}

/**
 * ⚠ 지난 주 발행분이 이번 주 상한을 먹으면 안 된다 — 그러면 매주 점점 못 쓰게 된다.
 */
{
  const lastWeek = ['2026-08-31', '2026-09-02', '2026-09-04'];
  ok('지난 주 발행분은 이번 주 상한에 안 들어간다', checkSlot(at('2026-09-07'), lastWeek).allowed);
}
/**
 * ⚠ 미래 날짜는 세지 않는다. 파일명이 잘못 붙은 글 하나가 그 주 발행을 통째로 막으면 안 된다.
 */
ok('미래 날짜는 세지 않는다', checkSlot(at('2026-09-07'), ['2026-12-25', '2026-12-26', '2026-12-27']).allowed);
ok('  └ 빈 목록도 안전', checkSlot(at('2026-09-07'), []).allowed);

console.log(`\n발행 슬롯: ${passN} pass / ${failN} fail`);
process.exit(failN ? 1 : 0);
