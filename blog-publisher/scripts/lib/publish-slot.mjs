/**
 * lib/publish-slot.mjs — 발행 슬롯 판정. 부작용 없는 순수 함수.
 *
 * 🔴 왜 필요한가: 주 3편(월·수·금) 상한이 지금까지 **런북 프롬프트에만** 있었다.
 *    런북은 `claude -p` 에 들어가는 지시문이라 **지켜지길 바라는 것이지 보장이 아니다.**
 *    같은 저장소의 카드뉴스는 이 교훈을 이미 배웠다 — 인스타에 삭제 API 가 없어서
 *    `slot.daily_cap` 을 코드가 KST 날짜 기준으로 강제한다(cron 이 아니라).
 *    블로그도 같은 선을 코드에 둔다.
 *
 * ⚠ 이 판정은 **차단이 아니라 근거 제공**이다. 호출부가 어떻게 쓸지 정한다 —
 *    지금은 경고·기록용이고, 승인 관문이 이미 공개를 막고 있어 과잉 발행의 피해가
 *    "토큰 낭비 + 승인 대기 적체"로 한정되기 때문이다. 공개 자체는 사람이 정한다.
 *
 * 시계는 주입받는다(테스트가 오늘에 의존하지 않게).
 */
import { kstDate } from '../kernel/clock.mjs';

/** 발행 요일 — 1=월 3=수 5=금 (ISO 요일). 단일 출처. */
export const PUBLISH_WEEKDAYS = [1, 3, 5];

/** 주간 상한. 발행 요일 수와 같아야 한다 — 하루 1편이므로. */
export const WEEKLY_CAP = PUBLISH_WEEKDAYS.length;

/** KST 기준 ISO 요일(1=월 … 7=일). */
export function kstWeekdayIso(now) {
  const [y, m, d] = kstDate(now).split('-').map(Number);
  // 정오 UTC 로 맞춰 자정 경계에서 하루가 밀리지 않게 한다(커널 clock 과 같은 이유).
  const wd = new Date(Date.UTC(y, m - 1, d, 3, 0, 0)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

/** 그 주의 월요일(KST) 날짜 문자열. 주 경계는 ISO-8601(월~일)을 쓴다. */
export function weekStart(now) {
  const iso = kstDate(now);
  const [y, m, d] = iso.split('-').map(Number);
  const base = Date.UTC(y, m - 1, d, 3, 0, 0);
  return kstDate(new Date(base - (kstWeekdayIso(now) - 1) * 86_400_000));
}

/**
 * 오늘 발행해도 되는가.
 *
 * @param {Date} now
 * @param {string[]} publishedDates 이번 주에 이미 발행한 글들의 날짜(YYYY-MM-DD)
 * @returns {{allowed: boolean, reason: string, weekday: number, usedThisWeek: number, cap: number}}
 */
export function checkSlot(now, publishedDates = []) {
  const weekday = kstWeekdayIso(now);
  const start = weekStart(now);
  const today = kstDate(now);
  // 이번 주(월요일 이후)에 발행된 것만 센다. 미래 날짜는 세지 않는다(잘못된 데이터 방어).
  const used = publishedDates.filter(d => d >= start && d <= today).length;

  if (!PUBLISH_WEEKDAYS.includes(weekday)) {
    return { allowed: false, reason: `발행 요일이 아니다(오늘 ${weekday}, 발행일 ${PUBLISH_WEEKDAYS.join('·')})`, weekday, usedThisWeek: used, cap: WEEKLY_CAP };
  }
  if (used >= WEEKLY_CAP) {
    return { allowed: false, reason: `주간 상한 도달(${used}/${WEEKLY_CAP})`, weekday, usedThisWeek: used, cap: WEEKLY_CAP };
  }
  return { allowed: true, reason: `발행 가능(${used}/${WEEKLY_CAP} 사용)`, weekday, usedThisWeek: used, cap: WEEKLY_CAP };
}
