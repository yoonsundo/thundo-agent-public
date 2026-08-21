/**
 * kernel/clock.mjs — KST 시계 (순수함수, 시계 주입형)
 *
 * 왜 있는가(F-08): 이 시스템에서 "오늘"은 정책 값이다. 카드뉴스 일일 발행 상한
 * (`slot.daily_cap`), 호기심 쇼츠 편수(`pick.daily_target`), 리포트 파일명이 전부
 * KST 날짜에 걸린다. 그런데 파생 방식이 12개 파일에 3가지로 흩어져 있었다 —
 * `toLocaleDateString('en-CA')`, `toLocaleDateString('sv-SE')`,
 * `new Intl.DateTimeFormat('en-CA')`.
 *
 * 더 문제는 대부분이 인자를 받지 않아 **시계를 주입할 수 없었다**는 점이다.
 * 그래서 이 시스템에서 가장 자주 사고가 나는 지점(자정 경계)을 테스트로 재현할
 * 방법이 없었다. 여기 함수들은 전부 `now` 를 받는다.
 *
 * 한국은 서머타임이 없어 KST 는 UTC+9 고정이다(1988년 이후). 그래도 오프셋을
 * 손으로 더하지 않고 Intl 에 맡긴다 — 규칙이 바뀌면 런타임이 따라오게.
 *
 * 커널 규약: fs·child_process 를 import 하지 않고, **인자 없는 `new Date()` 를
 * 만들지 않는다**(호출부가 시계를 준다).
 */

export const KST = 'Asia/Seoul';

/** 내부: 주어진 값을 Date 로. 문자열·숫자·Date 모두 받는다. */
function toDate(now) {
  if (now instanceof Date) return now;
  return new Date(now);
}

/**
 * KST 기준 날짜 `YYYY-MM-DD`.
 * @param {Date|string|number} now
 * @returns {string}
 */
export function kstDate(now) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: KST, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(toDate(now));
}

/**
 * KST 기준 시(0~23) — 정수. 크론 슬롯 판정에 쓴다.
 * @param {Date|string|number} now
 * @returns {number}
 */
export function kstHour(now) {
  const s = new Intl.DateTimeFormat('en-GB', {
    timeZone: KST, hour: '2-digit', hourCycle: 'h23',
  }).format(toDate(now));
  return Number.parseInt(s, 10);
}

/**
 * KST 기준 요일 약어 (`Mon`…`Sun`). 주말·공휴일 판정에 쓴다.
 * @param {Date|string|number} now
 * @returns {string}
 */
export function kstWeekday(now) {
  return new Intl.DateTimeFormat('en-US', { timeZone: KST, weekday: 'short' })
    .format(toDate(now));
}

/**
 * KST 기준 날짜를 일 단위로 이동한 `YYYY-MM-DD`.
 * 자정 경계에서 흔들리지 않도록 **KST 정오**를 기준점으로 잡고 움직인다.
 * @param {Date|string|number} now
 * @param {number} days 음수면 과거
 * @returns {string}
 */
export function kstDateShift(now, days) {
  const [y, m, d] = kstDate(now).split('-').map(Number);
  // 정오(UTC 03:00 = KST 12:00)에서 움직이면 DST·경계 문제가 생기지 않는다
  const base = Date.UTC(y, m - 1, d, 3, 0, 0);
  return kstDate(new Date(base + days * 86_400_000));
}
