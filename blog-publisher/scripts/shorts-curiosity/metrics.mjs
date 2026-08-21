#!/usr/bin/env node
/**
 * shorts-curiosity/metrics.mjs — 북극성 지표 1종 + 가드레일 3종
 *
 * 왜 이 파일이 생겼나 (2026-08-21):
 * 이 채널은 39일간 112편을 냈지만 조회수를 한 번도 자동 수집한 적이 없다. 그런데 그 상태에서
 * 설정을 두 번 조였고(08-05 whatif_ratio→0, reddit_bonus 0.05→0.12), 근거로 인용된 조회수는
 * 세션 중 손으로 잰 값이라 **원자료가 없어 재검증이 불가능**하다. 지표를 붙이는 목적은
 * "숫자를 늘리는 것"이 아니라 **다음에 설정을 조일 때 근거를 남기는 것**이다.
 * 계측 인벤토리: docs/reports/shorts/measurement-inventory-2026-08-21.md
 *
 * 설계 원칙
 *  ① 가드레일은 **우리 행동**을 본다 → state 만으로 오늘 계산된다(외부 의존 0).
 *  ② 북극성은 **시청자 반응**을 본다 → 데이터가 없으면 값 대신 **왜 없는지**를 낸다.
 *  ③ 어떤 경우에도 던지지 않는다 — 리포트가 이것 때문에 죽으면 안 된다(warn+계속 계약).
 */
import { loadIndex, loadBacklog, loadConfig } from './lib.mjs';
import { paths } from '../lib/config.mjs';
import { isNearDuplicate } from './pick.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ⚠ state 경로는 공용 `paths` 를 쓴다(STATE_DIR_OVERRIDE 준수). 직접 조립하면 테스트 격리 하에서
//   인덱스는 임시 state, 스냅샷은 실 state 를 읽는 스플릿브레인이 된다 — analytics-report·evolve 와
//   같은 경로 해석을 공유해야 한다.
const ANALYTICS_PATH = join(paths.state, 'shorts-curiosity', 'analytics.jsonl');

/** KST 날짜키. 발행 슬롯이 KST 기준이라 집계도 KST 로 맞춘다(UTC 로 세면 하루가 밀린다). */
export function kstDay(iso) {
  if (!iso) return '';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return String(iso).slice(0, 10);
  return new Date(t.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

const dayOf = (r) => kstDay(r?.uploaded_at || r?.at);
const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** 기준일(KST). 호출자가 안 주면 오늘. 다섯 군데서 같은 식을 쓰던 걸 한 곳으로 모았다. */
const resolveToday = (today) => today || kstDay(new Date().toISOString());

/** 업로드 완료분만. youtube_id 가 있어야 실제로 나간 것이다(produced/held 는 제외). */
export function uploadedEntries(index = {}) {
  return Object.values(index).filter(v => v?.youtube_id && dayOf(v));
}

/** 창(최근 N일) 안의 업로드분. `to` 포함, `to-(win-1)` 부터. */
function inWindow(entries, to, win) {
  const from = addDays(to, -(win - 1));
  return entries.filter(e => { const d = dayOf(e); return d >= from && d <= to; });
}

// ─────────────────────────────────────────────────────────────────────────────
// 가드레일 ① 발행 연속성
//
// 왜 필요한가: 7월 하락의 1순위 원인이 07-25·26 이틀 연속 업로드 0편이었다(감사 리포트).
// 그리고 북극성이 "편당 조회수"이므로, **편수를 줄이면 지표가 좋아지는 왜곡**이 구조적으로 있다
// (좋은 것만 골라 적게 내면 중앙값은 오른다). 이 가드레일이 그 지름길을 막는다.
// ─────────────────────────────────────────────────────────────────────────────
export function publishingContinuity(index = {}, { cfg = {}, today, window = 14 } = {}) {
  const target = Number(cfg?.pick?.daily_target) || 2;
  const entries = uploadedEntries(index);
  if (!entries.length) return { status: 'no-data', reason: '업로드 이력 없음' };

  const to = resolveToday(today);
  const counts = new Map();
  for (const e of entries) counts.set(dayOf(e), (counts.get(dayOf(e)) || 0) + 1);

  // 오늘은 아직 슬롯이 남아 있을 수 있으므로 결손 판정에서 제외한다(어제까지가 확정분).
  const lastComplete = addDays(to, -1);
  // ⚠ 창을 **첫 업로드 이전으로 넘기지 않는다.** 안 그러면 채널이 존재하지도 않던 날이
  //   전부 "결방"으로 잡힌다 — 신생 채널이나 창을 늘렸을 때 지표가 통째로 빨개진다.
  const firstDay = entries.map(dayOf).sort()[0];
  const from = [addDays(lastComplete, -(window - 1)), firstDay].sort().pop();
  const shortDays = [];
  for (let d = from; d <= lastComplete; d = addDays(d, 1)) {
    const n = counts.get(d) || 0;
    if (n < target) shortDays.push({ day: d, count: n, missing: target - n });
  }
  const zeroDays = shortDays.filter(s => s.count === 0);
  const lastZero = zeroDays.length ? zeroDays[zeroDays.length - 1].day : null;

  // 이행률 = 실제 발행 / 계획 발행. **결방일만 보면 지름길이 열린다** —
  // 하루 1편씩(계획의 절반) 꾸준히 내면 결방일은 0인데 부족분은 계속 쌓이고,
  // 북극성이 "편당 조회수"라 편수를 줄일수록 지표는 오른다. 즉 경보 없이 지표를 올릴 수 있다.
  // (실측 시뮬레이션: 목표 2편에 1편씩 14일 → 결방 0 · 부족 14편 · breach false 였다)
  let planned = 0, actual = 0;
  for (let d = from; d <= lastComplete; d = addDays(d, 1)) {
    planned += target;
    actual += counts.get(d) || 0;
  }
  const fulfillment = planned ? actual / planned : 1;
  const minFulfillment = Number(cfg?.metrics?.min_fulfillment) || 0.8;

  return {
    status: 'ok',
    window,
    target,
    today: counts.get(to) || 0,
    shortDays,
    zeroDays,
    missingTotal: shortDays.reduce((a, s) => a + s.missing, 0),
    daysSinceZero: lastZero ? Math.round((Date.parse(to) - Date.parse(lastZero)) / 86400000) : null,
    planned,
    actual,
    fulfillment,
    minFulfillment,
    breach: zeroDays.length > 0 || fulfillment < minFulfillment,
    note: zeroDays.length
      ? `최근 ${window}일에 발행 0편인 날 ${zeroDays.length}일 (${zeroDays.map(z => z.day).join(', ')})`
      : fulfillment < minFulfillment
        ? `최근 ${window}일 이행률 ${(fulfillment * 100).toFixed(0)}% (${actual}/${planned}편, 기준 ${(minFulfillment * 100).toFixed(0)}% 미달) — 결방은 없지만 계획보다 적게 내고 있다`
        : `최근 ${window}일 결방 없음 (이행률 ${(fulfillment * 100).toFixed(0)}%)`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 가드레일 ② 소재 다양성 (최대 도메인 점유율)
//
// 왜 필요한가: 조회수만 쫓으면 **잘 먹힌 분야로 수렴**한다. 실측(2026-08-21)에서 역사가
// **분야 기록이 있는 98편 중 33편(33.7%)** 이었고 7일 창 점유율이 08-12부터 열흘 연속
// 0.42~0.57 이었다. ⚠ 33/112(=29%)로 세면 안 된다 — 분야 결손 14편을 분모에 넣은 값이고,
// 이 함수가 배제하려는 바로 그 오류다.
//
// 🔴 **중요한 정정 (2026-08-21, 첫 실조회수 수집 후)**: 이 가드레일을 만들 때는 "역사 편중이
//    조회수 하락의 원인"이라고 가정했는데 **데이터가 그 가정을 부정한다.** 나이를 통제한
//    실측에서 역사는 중앙 1050회로 **상위권**이고, 약한 쪽은 인체(418)·음식(245)·심리(514)다.
//    즉 이 지표는 "편중 = 성과 하락"의 증거로 쓰면 안 된다.
//    그래도 남겨두는 이유는 둘이다 — ①한 분야로 굳으면 채널이 넓어지지 않고
//    ②사용자가 07-16 에 직접 "주제가 비슷하다"고 지적한 이력이 있다(시청자 체감).
//    **성과 근거가 아니라 다양성 자체를 지키는 장치**로 읽어야 한다.
//    ⚠ 그리고 "약한 분야를 피하라"로 성급히 바꾸지 말 것 — 음식 n=4·심리 n=4 로 표본이 작고,
//    표본이 얇은 상태에서 설정을 조인 것이 08-05 실패의 원인이었다.
// 사용자가 07-16 에 "주제가 비슷하다"고 지적한 것과 같은 상태다.
//
// 임계 0.40 은 추정이 아니라 **이력 34개 창의 분포에서** 골랐다:
//   중앙값 0.37 · 최대 0.57 · 0.40 초과 15창(최근 이상구간 10창 전량 + 이전 5창).
//   이전 5창 중 2창은 초기 domain 결손이 만든 허상이고 3창(07-24~08-01)은 실제 역사 쏠림이라
//   **오탐이 아니다.** 0.45 로 올리면 최근 이상구간 3창을 놓친다.
// ⚠ domain 이 없는 초기 항목은 **분모에서도 제외**한다 — '?' 를 한 분야로 세면 결손이
//   쏠림으로 둔갑한다(07-13~20 창이 그렇게 0.56 으로 잡혔다).
// ─────────────────────────────────────────────────────────────────────────────
export function topicDiversity(index = {}, { cfg = {}, today, window = 7 } = {}) {
  const limit = Number(cfg?.metrics?.max_domain_share) || 0.40;
  const minSample = Number(cfg?.metrics?.diversity_min_sample) || 5;
  const to = resolveToday(today);
  const win = inWindow(uploadedEntries(index), to, window);
  const withDomain = win.filter(e => e.domain);
  const skipped = win.length - withDomain.length;

  if (withDomain.length < minSample) {
    return { status: 'no-data', reason: `표본 부족(${withDomain.length}편 < ${minSample})`, window, skipped };
  }

  const counts = new Map();
  for (const e of withDomain) counts.set(e.domain, (counts.get(e.domain) || 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [topDomain, topCount] = ranked[0];
  const share = topCount / withDomain.length;

  // 같은 날 같은 분야 2편 — 자기 영상끼리 노출을 나눠 갖는 신호(별도 표시).
  const byDay = new Map();
  for (const e of withDomain) {
    const d = dayOf(e);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(e.domain);
  }
  const sameDayDupDays = [...byDay.entries()]
    .filter(([, doms]) => doms.length > 1 && new Set(doms).size < doms.length)
    .map(([d]) => d);

  return {
    status: 'ok',
    window,
    sample: withDomain.length,
    skipped,
    topDomain,
    topCount,
    share,
    limit,
    uniqueDomains: counts.size,
    distribution: Object.fromEntries(ranked),
    sameDayDupDays,
    breach: share > limit,
    note: share > limit
      ? `최근 ${window}일 '${topDomain}' 편중 ${(share * 100).toFixed(0)}% (기준 ${(limit * 100).toFixed(0)}% 초과)`
      : `최근 ${window}일 최대 편중 '${topDomain}' ${(share * 100).toFixed(0)}% — 정상`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 가드레일 ③ 재탕률 (같은 이야기 재발행)
//
// 왜 필요한가: 소재 풀이 마르면 시스템이 조용히 예전 주제를 다시 쓴다. 실측(2026-08-21)에서
// 전 이력 112편 중 12건이 재발행이었다(확정 2 · 의심 10). 최근 20편 중 3건이 3~5일 간격 재탕.
// **구독자에게 그대로 보이는 결함**이라 도메인 쏠림보다 우선순위가 높은데, 조회수 지표에는
// 안 잡힌다(재탕이어도 조회는 발생한다) — 그래서 별도 가드레일이 필요하다.
//
// 판정은 pick.mjs 의 isNearDuplicate 를 그대로 쓴다. 게이트와 **같은 함수·같은 임계**여야
// "게이트는 통과했는데 지표는 재탕이라 한다" 같은 모순이 안 생긴다.
//
// ⚠ 두 가지를 섞어 읽으면 안 된다.
//  ① **게이트 배포 이전 발행분**은 지금 임계로 소급 판정된 것이라 "그때 막았어야 했던 것"이지
//     "게이트가 뚫린 것"이 아니다. 배포 이후 건수가 0 을 유지하는지가 진짜 관전 포인트다.
//     → 이 지표는 사실상 **게이트 실효성 모니터**다. 0 에서 벗어나면 관문에 구멍이 생긴 것이다.
//  ② 임계 0.14 는 "놓치지 않는 쪽"에 둔 값이라 **오차단 2건을 감수**한다(config topic_note).
//     따라서 건수는 상한이지 확정 재탕 수가 아니다 — pairs 를 눈으로 확인하고 판단한다.
// ─────────────────────────────────────────────────────────────────────────────
export function repeatRate(index = {}, backlog = [], { cfg = {}, today, window = 30 } = {}) {
  const sim = cfg?.pick?.similarity;
  if (!sim || sim.enabled === false) return { status: 'off', reason: '유사도 게이트 비활성' };

  const to = resolveToday(today);
  const entries = uploadedEntries(index).sort((a, b) => (dayOf(a) < dayOf(b) ? -1 : 1));
  const from = addDays(to, -(window - 1));
  const recent = entries.filter(e => dayOf(e) >= from && e.subject);
  if (!recent.length) return { status: 'no-data', reason: `최근 ${window}일 발행 없음`, window };

  // 각 항목을 "그보다 먼저 나간 것들"과만 대조한다 — 시간순이라야 뒤에 나간 쪽이 재탕이다.
  const byId = new Map(backlog.map(b => [b?.id, b]).filter(([k]) => k));
  const subjectOf = (e, id) => e.subject || byId.get(id)?.subject || '';
  const ordered = entries
    .map(e => ({ e, day: dayOf(e), at: e.uploaded_at || e.at || '', subject: subjectOf(e) }))
    .filter(x => x.subject);

  const pairs = [];
  for (let i = 0; i < ordered.length; i++) {
    const cur = ordered[i];
    if (cur.day < from) continue;
    const priors = ordered.slice(0, i).map(x => x.subject);
    if (!priors.length) continue;
    const d = isNearDuplicate(cur.subject, priors, sim);
    if (d.dup) pairs.push({ day: cur.day, at: cur.at, subject: cur.subject, against: d.against, by: d.by });
  }

  // ⚠ 관문 배포 **이전** 발행분과 이후를 나눈다.
  //   관문(topic 유사도)은 2026-08-21 11:02 KST 에 켜졌다. 검출된 12건이 전부 그 이전
  //   발행분이라, 나누지 않으면 관문이 완벽히 작동해도 **30일 창이 비워질 때까지 매일
  //   빨간불**이 뜬다 — 경보 피로를 만들고 "0 에서 벗어나면 관문에 구멍"이라는 판독법도 깨진다.
  //   (이 지표를 브리핑에 넣은 근거가 "매일 경보가 나갔는데도 한 달 방치됐다"였는데
  //    같은 패턴을 새로 만드는 셈이다.)
  //   → 이후 발행분만 위반으로 올리고, 이전 발행분은 **사람이 한 번 훑을 목록**으로 남긴다.
  // ⚠ **날짜가 아니라 시각으로** 비교한다. 관문은 2026-08-21 11:02 KST 에 켜졌는데,
  //   같은 날 10:03 KST 에 나간 건이 있다 — 날짜만 보면 관문 이후로 잘못 분류된다(실측).
  const gateSince = cfg?.metrics?.repeat_gate_since || '';
  const gateMs = gateSince ? Date.parse(gateSince) : NaN;
  const isPostGate = (p) => {
    if (!gateSince) return true;
    const t = Date.parse(p.at || '');
    if (Number.isNaN(gateMs) || Number.isNaN(t)) return p.day >= gateSince.slice(0, 10);  // 폴백: 날짜 비교
    return t >= gateMs;
  };
  const postGate = pairs.filter(isPostGate);
  const preGate = pairs.filter(p => !isPostGate(p));

  // ⚠ 두 판정을 한 숫자로 뭉치면 과장 보고가 된다.
  //   wording(문구변형·포함관계) = 같은 문장을 손본 것이라 사실상 확정 재탕.
  //   topic(내용어 유사) = 놓치지 않으려고 임계를 낮춘 쪽이라 **오탐을 포함한다.**
  //   실측 오탐 예: 「항공사의 본업은 마일리지」↔「비행기 창문은 왜 둥근가」 — 둘 다 비행기가
  //   나올 뿐 다른 이야기인데 topic 으로 잡혔다. 그래서 확정과 의심을 나눠 낸다.
  const confirmed = postGate.filter(p => p.by === 'wording');
  const suspected = postGate.filter(p => p.by !== 'wording');
  return {
    status: 'ok',
    window,
    sample: recent.length,
    count: pairs.length,
    postGate: postGate.length,
    preGate: preGate.length,
    gateSince,
    confirmed: confirmed.length,
    suspected: suspected.length,
    rate: recent.length ? pairs.length / recent.length : 0,
    pairs,
    // ⚠ 둘 다 위반이다. 한때 확정(wording)만 위반으로 두었는데, 그러면 실제 3회 발행된
    //    「대공황 토론토 유언장 출산 레이스」(08-06·08-09·08-11)가 전부 topic 이라 조용히
    //    통과했다. 실측 10건의 topic 중 진짜 재탕이 8건, 오탐은 2건뿐이라 — 오탐 2건을
    //    피하려고 진짜 8건을 놓치는 교환이 된다. config topic_note 의 비대칭 비용 논리
    //    (오차단=다음 후보가 슬롯을 채움 / 미차단=구독자가 재탕을 봄)와도 방향이 반대다.
    //    확정/의심 구분은 **분류로만** 남겨 어느 걸 눈으로 볼지 알려준다.
    // 관문 이후 재발행이 1건이라도 있으면 위반 = 관문에 구멍이 생겼다는 신호.
    breach: postGate.length > 0,
    note: postGate.length
      ? `최근 ${window}일 관문 가동 후 재발행 ${postGate.length}건(확정 ${confirmed.length} · 의심 ${suspected.length})`
        + (preGate.length ? ` · 관문 이전 발행분 ${preGate.length}건은 별도 정리 대상` : '')
      : preGate.length
        ? `최근 ${window}일 관문 가동 후 재발행 없음 · 관문 이전 발행분 ${preGate.length}건은 정리 대상(경보 아님)`
        : `최근 ${window}일 재발행 없음 (${recent.length}편)`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 북극성 지표 — 발행 후 7일 조회수 중앙값 (D7 median views)
//
// 왜 이 지표인가
//  · 사용자 가치: 이 채널이 주는 건 "몰랐던 걸 알게 되는 40초"다. 전달됐다는 최소 증거가 조회다.
//  · 반복성: **중앙값이라 한 편이 터져도 안 오른다.** 올리려면 매 편이 고르게 좋아야 하고,
//    이건 "매일 자동 발행"이라는 이 제품의 구조와 정확히 맞는 요구다.
//  · 장기 성장: 쇼츠는 채널 단위로 초기 노출을 배분하므로 편당 하한선이 구독 성장의 선행지표다.
//
// ⚠ 평균이 아니라 중앙값인 이유는 취향이 아니다. 2026-08-05 에 **평균**(reveal 1022 vs
//   whatif 738)으로 앵글 하나를 통째로 껐는데, 그 표본은 whatif 가 5편 연속 나간 편중 구간이라
//   오염돼 있었다. 중앙값이었으면 그 결정이 안 나왔을 가능성이 크다.
//
// ⚠ 계측 조건: analytics 의 views 는 **누적 스냅샷**이라 D7 을 얻으려면 게시일+7일 근처
//   스냅샷이 필요하다. 즉 수집을 시작해도 **7일 뒤부터** 값이 생긴다. 그 전에는 값을 지어내지
//   않고 status='collecting' 으로 남은 일수를 알린다.
// ─────────────────────────────────────────────────────────────────────────────

/** analytics.jsonl 로드(없으면 빈 배열). 손상 라인은 건너뛴다 — 리포트를 죽이지 않는다. */
export function loadAnalytics(path = ANALYTICS_PATH) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const rec = JSON.parse(s);
      // ⚠ mock 합성 라인은 성과가 아니다. 안 거르면 사람이 `RUN_MODE=mock` 으로 수집을 한 번
      //   돌린 순간부터 "스냅샷 있음"으로 보여 **"YOUTUBE_API_KEY 를 넣어라"는 유일한 조치
      //   안내가 사라진다**(합성 라인은 published_at 이 null 이라 D7 도 못 낸다).
      //   analytics-report 의 keepReal() 과 같은 판단이다.
      if (rec && rec.mock) continue;
      out.push(rec);
    } catch { /* 손상 라인 무시 */ }
  }
  return out;
}

/**
 * 스냅샷들에서 영상별 D7 조회수를 뽑는다.
 * 게시 후 [7일, 7일+tolerance] 안의 스냅샷 중 **가장 이른 것**을 쓴다 —
 * 늦은 걸 쓰면 그만큼 누적이 더해져 D7 이 과대평가된다.
 */
export function d7Views(snapshots = [], { toleranceDays = 2 } = {}) {
  const byVideo = new Map();
  for (const s of snapshots) {
    // ⚠ 수집기가 쓰는 필드는 `youtube_id` 다(analytics-collect.mjs:410, groupById 도 동일).
    //    `video_id` 로 읽던 버그가 있었다 — 이 파이프라인은 그 이름을 생산한 적이 없어
    //    d7Views 가 항상 빈 배열을 냈고, 리포트에는 "수집 N일차 · 0일 뒤부터"라는
    //    영구히 거짓인 문구가 찍혔다. 스프레드(`{ ts, ...r }`)만 보고 필드명을 추정한 탓이다.
    const id = s.youtube_id || s.video_id || s.videoId || s.id;
    if (!id || !s.published_at || s.views == null || !s.ts) continue;
    if (!byVideo.has(id)) byVideo.set(id, []);
    byVideo.get(id).push(s);
  }
  const out = [];
  for (const [id, snaps] of byVideo) {
    snaps.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const pub = Date.parse(snaps[0].published_at);
    if (Number.isNaN(pub)) continue;
    const lo = pub + 7 * 86400000;
    const hi = lo + toleranceDays * 86400000;
    const hit = snaps.find(s => { const t = Date.parse(s.ts); return t >= lo && t <= hi; });
    if (hit) out.push({ video_id: id, views: Number(hit.views), published_at: snaps[0].published_at, title: hit.title || '' });
  }
  return out;
}

export function northStar({ snapshots = null, cfg = {}, today, window = 30 } = {}) {
  const snaps = snapshots ?? loadAnalytics();
  if (!snaps.length) {
    return {
      status: 'no-data',
      metric: 'D7 조회수 중앙값',
      reason: '성과 스냅샷 0건 — analytics.jsonl 미생성',
      action: '.env 에 YOUTUBE_API_KEY 추가 후 `npm run curiosity:analytics` (공개 영상이라 재동의 불필요)',
    };
  }

  const to = resolveToday(today);
  const all = d7Views(snaps);
  const from = addDays(to, -(window - 1));
  const win = all.filter(x => kstDay(x.published_at) >= from);

  if (!win.length) {
    // 스냅샷은 있는데 D7 이 아직 없다 = 수집 시작 후 7일이 안 지났다.
    const firstTs = snaps.map(s => s.ts).filter(Boolean).sort()[0];
    const daysCollected = Math.max(0, firstTs ? Math.floor((Date.parse(to) - Date.parse(firstTs)) / 86400000) : 0);
    const daysRemaining = Math.max(0, 7 - daysCollected);
    // ⚠ "수집 N일차 — 0일 뒤부터 값이 나옵니다" 는 **거짓말이 될 수 있다.**
    //   수집이 7일을 넘겼는데도 D7 이 없다면 그건 '아직 기다리는 중'이 아니라 다른 문제다
    //   (창 안에 발행분이 없거나, published_at 이 전부 결손이거나, 필드가 안 맞거나).
    //   실제로 필드명 불일치 때 이 문구가 영구히 찍혔다 — 상태를 나눠 원인을 드러낸다.
    if (daysRemaining === 0) {
      const withPub = all.length;
      return {
        status: 'no-data',
        metric: 'D7 조회수 중앙값',
        daysCollected,
        reason: withPub
          ? `수집 ${daysCollected}일차이고 D7 산출분 ${withPub}편이 있으나 최근 ${window}일 발행분이 없다 — 창을 넓히거나 발행 재개가 필요하다`
          : `수집 ${daysCollected}일차인데 D7 을 낼 수 있는 스냅샷이 0건 — published_at 결손이나 레코드 형식 불일치를 의심한다`,
      };
    }
    return {
      status: 'collecting',
      metric: 'D7 조회수 중앙값',
      daysCollected,
      daysRemaining,
      reason: `수집 ${daysCollected}일차 — D7 은 게시 후 7일 스냅샷이 있어야 산출된다`,
    };
  }

  const vals = win.map(x => x.views).filter(Number.isFinite);
  // D7 후보는 있는데 유효 수치가 하나도 없으면 ok 가 아니다 — 여기서 ok 를 내면
  // "중앙값 null회" 같은 지어낸 값이 리포트에 찍힌다(값이 없으면 이유를 낸다는 원칙 위반).
  if (!vals.length) {
    return {
      status: 'no-data',
      metric: 'D7 조회수 중앙값',
      reason: `D7 대상 ${win.length}편이 있으나 유효한 조회수가 0건 — 스냅샷 손상 의심`,
    };
  }
  return {
    status: 'ok',
    metric: 'D7 조회수 중앙값',
    window,
    sample: vals.length,
    median: median(vals),
    min: Math.min(...vals),
    max: Math.max(...vals),
    note: `최근 ${window}일 발행 ${vals.length}편의 D7 중앙값 ${median(vals)}회`,
  };
}

/** 북극성 1 + 가드레일 3 을 한 번에. 어떤 항목이 실패해도 나머지는 낸다. */
export function computeMetrics({ index, backlog, cfg, today, snapshots } = {}) {
  const safe = (fn, label) => {
    try { return fn(); } catch (e) { return { status: 'error', reason: `${label} 계산 실패: ${e.message}` }; }
  };
  // 로더도 감싼다 — 밖에 두면 config 가 깨졌을 때 computeMetrics 자체가 throw 하고
  // try/catch 가 없는 호출부(npm run curiosity:metrics)가 스택트레이스로 죽는다.
  // safe() 는 실패 시 **에러 객체**를 돌려주므로 로더에는 쓸 수 없다(기본값으로 안 떨어진다).
  const load = (fn, fallback) => { try { return fn() ?? fallback; } catch { return fallback; } };
  const idx = index ?? load(loadIndex, {});
  const bl = backlog ?? load(loadBacklog, []);
  const c = cfg ?? load(loadConfig, {});
  // ⚠ 창 길이도 config 에서 읽어 넘긴다. 안 넘기면 함수 기본값(14·7·30)이 쓰여
  //    config 의 *_window_days 가 **죽은 손잡이**가 된다 — 운영자는 창을 바꿨다고 믿는데
  //    아무 일도 안 일어난다(실측으로 확인된 결함, 2026-08-21).
  const win = (key, dflt) => {
    const v = Number(c?.metrics?.[key]);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : dflt;
  };
  return {
    generated_at: new Date().toISOString(),
    today: resolveToday(today),
    north_star: safe(() => northStar({ snapshots, cfg: c, today, window: win('north_star_window_days', 30) }), '북극성'),
    guardrails: {
      continuity: safe(() => publishingContinuity(idx, { cfg: c, today, window: win('continuity_window_days', 14) }), '발행 연속성'),
      diversity: safe(() => topicDiversity(idx, { cfg: c, today, window: win('diversity_window_days', 7) }), '소재 다양성'),
      repeat: safe(() => repeatRate(idx, bl, { cfg: c, today, window: win('repeat_window_days', 30) }), '재탕률'),
    },
  };
}

/** 사람이 읽는 마크다운 섹션. 정상이면 조용하고, 위반이면 눈에 띄게 적는다. */
export function renderMetrics(m) {
  const L = [];
  const ns = m.north_star || {};
  // ⚠ 기준일을 반드시 찍는다. 이 리포트의 파일명·제목은 UTC 날짜인데(기존 관례) 지표는
  //   KST 기준이라, 02:00 KST 크론에서는 둘이 하루 다르다. 명시하지 않으면 같은 문서 안의
  //   두 날짜를 보고 어느 쪽이 맞는지 알 수 없다. 파일명 관례는 기존 시계열이 있어 안 건드린다.
  if (m.today) L.push(`> 지표 기준일 **${m.today}** (KST) — 이 문서의 제목·파일명은 UTC 날짜라 다를 수 있다.`, '');
  L.push('## 🧭 북극성 지표 — D7 조회수 중앙값');
  L.push('');
  if (ns.status === 'ok') {
    L.push(`- **${ns.median}회** (최근 ${ns.window}일 발행 ${ns.sample}편 · 최소 ${ns.min} / 최대 ${ns.max})`);
  } else if (ns.status === 'collecting') {
    L.push(`- ⏳ 수집 ${ns.daysCollected}일차 — **${ns.daysRemaining}일 뒤부터** 값이 나옵니다.`);
    L.push(`  - ${ns.reason}`);
  } else {
    L.push(`- ⚠ **산출 불가** — ${ns.reason}`);
    if (ns.action) L.push(`  - 필요한 조치: ${ns.action}`);
  }
  L.push('');

  L.push('## 🛡 가드레일');
  L.push('');
  const g = m.guardrails || {};
  const row = (icon, title, r) => {
    if (!r || r.status === 'no-data' || r.status === 'off' || r.status === 'error') {
      L.push(`- ${icon} **${title}**: 산출 불가 — ${r?.reason || '알 수 없음'}`);
      return;
    }
    L.push(`- ${r.breach ? '🔴' : '🟢'} **${title}**: ${r.note}`);
  };
  row('📅', '발행 연속성', g.continuity);
  if (g.continuity?.status === 'ok' && g.continuity.missingTotal > 0 && !g.continuity.breach) {
    L.push(`  - 계획 대비 부족분 ${g.continuity.missingTotal}편 (완전 결방은 아님)`);
  }
  row('🎯', '소재 다양성', g.diversity);
  if (g.diversity?.status === 'ok' && g.diversity.sameDayDupDays?.length) {
    L.push(`  - 같은 날 같은 분야 2편: ${g.diversity.sameDayDupDays.length}일 (${g.diversity.sameDayDupDays.join(', ')})`);
  }
  row('♻️', '재탕률', g.repeat);
  for (const p of (g.repeat?.pairs || []).slice(0, 5)) {
    L.push(`  - ${p.by === 'wording' ? '확정' : '의심'} · ${p.day} 「${p.subject}」 ↔ 「${p.against}」`);
  }
  return L.join('\n');
}
