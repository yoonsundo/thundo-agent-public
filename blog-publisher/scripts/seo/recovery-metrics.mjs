/**
 * seo/recovery-metrics.mjs — 스팸 조치 회복 계측의 **순수 계산부** (I/O 없음)
 *
 * 왜 있는가: 2026-08-17 구글 노출이 절벽처럼 끊겼다(7월 주 63.8회 → 8/17 이후 주 2.6회).
 * 1차 조치(주 3편 감축·사람 승인 관문·조작 1인칭 차단 게이트)는 배포됐지만,
 * **회복했는지 볼 수 있는 지표가 없었다.** 회복은 노출보다 "색인된·노출을 받는 페이지 수"에서
 * 먼저 보이는데 그 숫자를 아무도 모으지 않았다.
 *
 * 계산과 I/O 를 나눠 둔 이유는 하나다 — 판정선이 걸린 산식은 테스트가 지켜야 한다.
 * 파일을 읽는 쪽은 `recovery-report.mjs`, 여기는 자료구조만 받는다.
 *
 * 🔴 이 파일이 지키는 두 가지 규칙
 *   ① **0 과 null 을 구분한다.** seo-metrics.jsonl 에는 노출 0 인 날의 레코드가 아예 없다
 *      (gsc-collect 의 groupByDate 는 행이 있는 날짜만 만든다). 그래서 레코드가 없는 날은
 *      "노출 0회"일 수도, "그날은 수집조차 안 됐다"일 수도 있다. 수집 런이 실제로 물어본
 *      구간(collectionWindow)에 드는 날만 0 으로 확정하고, 나머지는 null(모름)로 둔다.
 *   ② **구글과 네이버를 절대 합산하지 않는다.** 다른 엔진이고 표본 정의도 다르다.
 *      함수 시그니처부터 분리해 둔다.
 */

// ── 날짜 유틸 (전부 UTC 산술 — 날짜 문자열만 다루므로 타임존이 끼어들 여지가 없다) ──

/** `YYYY-MM-DD` → Date(UTC 자정). */
function toUtc(iso) { return new Date(String(iso) + 'T00:00:00Z'); }

/** Date → `YYYY-MM-DD`. */
function toIso(d) { return d.toISOString().slice(0, 10); }

/** 날짜 문자열에 n일을 더한다. */
export function addDaysIso(iso, n) {
  const d = toUtc(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toIso(d);
}

/**
 * 그 날짜가 속한 주의 **월요일**.
 *
 * 왜 월요일인가: 판정선이 "4주 연속 주 20회 이상"이라 주 경계가 흔들리면 판정도 흔들린다.
 * ISO-8601 주(월~일)를 쓴다. 발행 요일이 월·수·금이라 발행 주기와도 어긋나지 않는다.
 */
export function mondayOf(iso) {
  const d = toUtc(iso);
  const dow = d.getUTCDay();              // 0=일 … 6=토
  const back = dow === 0 ? 6 : dow - 1;   // 일요일은 6일 전이 월요일
  d.setUTCDate(d.getUTCDate() - back);
  return toIso(d);
}

/**
 * 오늘이 속한 주로 끝나는 최근 n주 목록(월~일).
 *
 * 왜 별도로 필요한가: 발행 편수와 조작표현 스캔은 **달력**에 걸린 사실이지만, GSC 주 목록은
 * 수집 데이터가 끝나는 곳에서 멈춘다(구글 데이터는 2~3일 지연된다). GSC 주로 발행을 세면
 * "이번 주"가 사실은 지난주가 되어, 오늘 발행한 글이 상한 감시에서 빠진다.
 */
export function recentWeeks(today, n) {
  const thisWeek = mondayOf(today);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const ws = addDaysIso(thisWeek, -7 * i);
    out.push({ weekStart: ws, weekEnd: addDaysIso(ws, 6) });
  }
  return out;
}

/** [start, end] 양끝 포함 날짜 배열. */
export function dateRangeInclusive(start, end) {
  const out = [];
  for (let d = start; d <= end; d = addDaysIso(d, 1)) out.push(d);
  return out;
}

// ── 수집 시도 여부 (0 과 null 을 가르는 근거) ────────────────────────────────

/**
 * 레코드의 `collected_at` 은 "그날 수집 런이 돌았다"는 증거다. 그 런이 물어본 구간을
 * 합집합하면 **수집이 시도된 날짜 집합**이 된다. 여기 없는 날짜는 0 이 아니라 모름이다.
 *
 * @param {Array<{collected_at?:string}>} records seo-metrics 레코드 배열
 * @param {(runDate:string)=>{startDate:string,endDate:string}} windowFn 보통 gsc-collect 의 collectionWindow
 * @returns {Set<string>}
 */
export function attemptedDates(records, windowFn) {
  const runDays = new Set();
  for (const r of records || []) {
    const at = r && r.collected_at;
    if (typeof at === 'string' && /^\d{4}-\d{2}-\d{2}/.test(at)) runDays.add(at.slice(0, 10));
  }
  const out = new Set();
  for (const day of runDays) {
    const { startDate, endDate } = windowFn(day);
    for (const d of dateRangeInclusive(startDate, endDate)) out.add(d);
  }
  return out;
}

// ── GSC 집계 ────────────────────────────────────────────────────────────────

/**
 * page 차원 레코드에서 blog 글 URL 만 골라 slug 별로 합산한다.
 *
 * 목록·태그·홈 URL(`/blog`, `/blog?tag=…`, `/`)은 글이 아니므로 뺀다 — 넣으면
 * "노출을 받은 글 수"가 부풀려진다(실측 69개 키 중 13개가 글이 아니다).
 *
 * @param {Array} records seo-metrics 레코드 배열(page·query 섞여 있어도 됨)
 * @param {(url:string)=>string|null} slugFromUrl 글 URL → slug (아니면 null)
 * @param {{from?:string,to?:string}} range 날짜 필터(양끝 포함). 생략하면 전 기간.
 */
export function aggregateBlogExposure(records, slugFromUrl, range = {}) {
  const bySlug = new Map();
  for (const rec of records || []) {
    if (!rec || rec.dimension !== 'page') continue;
    if (range.from && rec.date < range.from) continue;
    if (range.to   && rec.date > range.to)   continue;
    for (const row of rec.rows || []) {
      const slug = slugFromUrl(row.key);
      if (!slug) continue;
      const imp = row.impressions || 0;
      if (imp <= 0) continue;               // 노출 0 행은 "노출을 받은 적 있다"의 근거가 아니다
      const cur = bySlug.get(slug) || {
        impressions: 0, clicks: 0, days: 0, weightedPositionSum: 0,
        firstDate: null, lastDate: null,
      };
      cur.impressions += imp;
      cur.clicks      += row.clicks || 0;
      cur.days        += 1;
      if (Number.isFinite(row.position)) cur.weightedPositionSum += row.position * imp;
      if (!cur.firstDate || rec.date < cur.firstDate) cur.firstDate = rec.date;
      if (!cur.lastDate  || rec.date > cur.lastDate)  cur.lastDate  = rec.date;
      bySlug.set(slug, cur);
    }
  }
  return bySlug;
}

/**
 * 일별 노출·클릭 시계열. 레코드가 없는 날은 attempted 여부로 **0 인지 모름인지** 가른다.
 * @returns {Array<{date:string,impressions:number|null,clicks:number|null,known:boolean}>}
 */
export function dailySeries(records, attempted, { from, to } = {}) {
  const byDate = new Map();
  for (const rec of records || []) {
    if (!rec || rec.dimension !== 'page') continue;
    const imp = (rec.rows || []).reduce((s, r) => s + (r.impressions || 0), 0);
    const clk = (rec.rows || []).reduce((s, r) => s + (r.clicks || 0), 0);
    byDate.set(rec.date, { impressions: imp, clicks: clk });
  }
  const recordDates = [...byDate.keys()].sort();
  const attemptedList = [...(attempted || [])].sort();
  if (!recordDates.length && !attemptedList.length) return [];

  const start = from || recordDates[0] || attemptedList[0];
  // 마지막 레코드 뒤에도 "수집은 했는데 노출이 0이라 레코드가 없는" 날이 있다.
  // 그 날들을 잘라내면 최근 주의 노출이 실제보다 커 보인다(분모가 사라지므로).
  const lastAttempted = attemptedList.length ? attemptedList[attemptedList.length - 1] : null;
  const lastRecord    = recordDates.length ? recordDates[recordDates.length - 1] : null;
  const end = to || [lastAttempted, lastRecord].filter(Boolean).sort().pop();

  return dateRangeInclusive(start, end).map(date => {
    const hit = byDate.get(date);
    if (hit) return { date, impressions: hit.impressions, clicks: hit.clicks, known: true };
    if (attempted && attempted.has(date)) return { date, impressions: 0, clicks: 0, known: true };
    return { date, impressions: null, clicks: null, known: false };
  });
}

/**
 * 일별 → 주별(월요일 시작) 집계.
 *
 * `partial: true` 는 그 주에 모르는 날이 섞였다는 뜻이고, 그때 `impressions` 는
 * **하한**이다(모르는 날의 노출을 0 으로 세지 않고 아예 빼기 때문). 판정에서 이 구분이
 * 중요하다 — 하한이 이미 판정선을 넘으면 결론은 확정이지만, 못 넘으면 결론은 미정이다.
 */
export function weeklyRollup(daily) {
  const weeks = new Map();
  for (const d of daily) {
    const ws = mondayOf(d.date);
    const w = weeks.get(ws) || { weekStart: ws, weekEnd: addDaysIso(ws, 6), impressions: 0, clicks: 0, knownDays: 0, unknownDays: 0 };
    if (d.known) { w.impressions += d.impressions; w.clicks += d.clicks; w.knownDays += 1; }
    else w.unknownDays += 1;
    weeks.set(ws, w);
  }
  return [...weeks.values()]
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart))
    .map(w => ({ ...w, partial: w.unknownDays > 0, coveredDays: w.knownDays + w.unknownDays }));
}

/** 구간 합계와 "주당 환산" — 기준선(63.8/41.1/2.6)이 이 산식으로 나온다. */
export function windowRate(daily, from, to) {
  let impressions = 0, known = 0, unknown = 0;
  for (const d of daily) {
    if (d.date < from || d.date > to) continue;
    if (d.known) { impressions += d.impressions; known += 1; } else unknown += 1;
  }
  const spanDays = dateRangeInclusive(from, to).length;
  return {
    from, to, spanDays, impressions, knownDays: known, unknownDays: unknown,
    perWeek: spanDays > 0 ? (impressions / spanDays) * 7 : null,
  };
}

// ── 판정 ────────────────────────────────────────────────────────────────────

export const THRESHOLDS = {
  /** 회복 판정선: 주간 구글 노출 합계. 8/17 이후 실측 주 2.6회, 절벽 전 주 63.8회의 사이에 둔 값. */
  weeklyImpressions: 20,
  /** 몇 주 연속이어야 회복으로 보는가. 한두 주는 잡음이라 4주로 둔다. */
  consecutiveWeeks: 4,
  /** 노출된 글의 평균순위 중앙값 기준선(2026-09-07 실측 7.3위). 올릴 목표가 아니라 경보선이다. */
  positionBaseline: 7.3,
  /** 기준선보다 이만큼 나빠지면 경보. 2.0 은 검색결과 한 페이지 안에서의 이동 폭 — 판단값이다. */
  positionAlarmDelta: 2.0,
  /** 주간 발행 상한(주 3편, 월·수·금). 늘릴 목표가 아니라 넘으면 그 자체가 실패인 선이다. */
  weeklyPublishCap: 3,
};

/**
 * 회복 판정 — **완료된 주**만 본다(진행 중인 주는 아직 합계가 아니다).
 *
 * @returns {{recovered:boolean, streak:number, needed:number, weeks:Array, lastCompleteWeek:object|null}}
 */
export function recoveryStatus(weeks, asOf, opts = THRESHOLDS) {
  const complete = weeks.filter(w => w.weekEnd < asOf);
  let streak = 0;
  for (let i = complete.length - 1; i >= 0; i--) {
    const w = complete[i];
    // partial 주라도 하한이 판정선을 넘었으면 확정이다. 못 넘었으면 연속이 끊긴다.
    if (w.impressions >= opts.weeklyImpressions) streak += 1;
    else break;
  }
  return {
    recovered: streak >= opts.consecutiveWeeks,
    streak,
    needed: opts.consecutiveWeeks,
    threshold: opts.weeklyImpressions,
    lastCompleteWeek: complete.length ? complete[complete.length - 1] : null,
  };
}

/**
 * 노출을 한 번이라도 받은 고유 blog URL 누적수 — **분자와 분모를 따로 싣는다.**
 *
 * ⚠ 왜 비율만 쓰면 안 되는가: 1차 조치로 발행이 주 3편으로 줄어 분모 증가가 멈춘다.
 * 그러면 분자가 그대로여도 다음 주 비율이 오르지 않고, 반대로 분자가 조금만 늘어도
 * 비율이 크게 오른다. 어느 쪽이든 비율 하나로는 무슨 일이 일어났는지 알 수 없다.
 * 그래서 주별로 분자·분모의 **증분**을 같이 기록한다.
 *
 * @param {Map} bySlug aggregateBlogExposure 결과 (firstDate 필요)
 * @param {Array<{slug:string,date:string}>} posts published/ 목록
 * @param {Array<{weekEnd:string}>} weeks 시점 목록
 */
export function coverageSeries(bySlug, posts, weeks) {
  const firstByslug = [...bySlug.entries()]
    .filter(([, v]) => v.impressions > 0 && v.firstDate)
    .map(([slug, v]) => ({ slug, firstDate: v.firstDate }));

  let prev = null;
  return weeks.map(w => {
    const at = w.weekEnd;
    const exposed = firstByslug.filter(e => e.firstDate <= at).length;
    const total   = posts.filter(p => p.date && p.date <= at).length;
    const row = {
      at,
      exposed,
      total,
      ratio: total > 0 ? exposed / total : null,     // 분모 0 이면 비율은 0 이 아니라 없음
      exposedDelta: prev ? exposed - prev.exposed : null,
      totalDelta:   prev ? total   - prev.total   : null,
    };
    prev = row;
    return row;
  });
}

/**
 * 노출된 글의 "평균순위"의 중앙값.
 *
 * 글마다 노출가중 평균순위를 내고, 그 값들의 **중앙값**을 쓴다. 평균이 아니라 중앙값인 이유는
 * 순위 분포가 꼬리가 길어(30위권 글 몇 편) 평균이 실제 체감과 어긋나기 때문이다.
 * @returns {number|null} 표본이 없으면 null(0 위가 아니다)
 */
export function medianAvgPosition(bySlug) {
  const vals = [];
  for (const v of bySlug.values()) {
    if (!(v.impressions > 0) || !(v.weightedPositionSum > 0)) continue;
    vals.push(v.weightedPositionSum / v.impressions);
  }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
}

/** 순위 경보 판정. 수치가 **커지면** 나빠진 것이다. */
export function positionAlarm(median, opts = THRESHOLDS) {
  if (median == null) return { status: 'unknown', median: null, limit: opts.positionBaseline + opts.positionAlarmDelta };
  const limit = opts.positionBaseline + opts.positionAlarmDelta;
  return { status: median > limit ? 'alarm' : 'ok', median, limit, baseline: opts.positionBaseline };
}

/**
 * 네이버 노출 쿼리 수 — **가장 최근 수집일 기준**.
 *
 * 🔴 구글 지표와 절대 합산하지 않는다. 다른 엔진이고, 여기 표본은 "글"이 아니라 "타겟 쿼리"다.
 * rank 가 null 인 것은 "순위 없음"이 아니라 display 상한(30) 밖이라 **모르는 것**이다.
 * 그래서 노출로 세지 않되, 미노출로 단정하지도 않고 pool 밖이라고 적는다.
 */
export function naverSnapshot(records) {
  const byDate = new Map();
  for (const rec of records || []) {
    if (!rec || !rec.date) continue;
    if (!byDate.has(rec.date)) byDate.set(rec.date, new Map());
    byDate.get(rec.date).set(rec.query, rec);          // 같은 (날짜,쿼리)는 마지막이 이긴다
  }
  const dates = [...byDate.keys()].sort();
  if (!dates.length) return { date: null, totalQueries: 0, exposedQueries: null, exposed: [] };
  const date = dates[dates.length - 1];
  const rows = [...byDate.get(date).values()];
  const exposed = rows
    .filter(r => r.best && r.best.rank != null)
    .map(r => ({ query: r.query, rank: r.best.rank, type: r.best.type, url: r.best.url || null }))
    .sort((a, b) => a.rank - b.rank);
  return { date, totalQueries: rows.length, exposedQueries: exposed.length, exposed };
}

/**
 * 주간 발행 편수 — 상한(주 3편) 위반 감시.
 *
 * @param {Map<string, number|null>} countByDate 날짜 → 편수. **null 은 "기록이 없다"**이고
 *        0("그날 발행 안 함")과 다르다. run.json 의 published 가 배열이 아닌 날이 실제로 있었다.
 */
export function weeklyPublishCounts(countByDate, weeks, opts = THRESHOLDS) {
  return weeks.map(w => {
    const days = dateRangeInclusive(w.weekStart, w.weekEnd);
    let count = 0, knownDays = 0, unknownDays = 0;
    for (const d of days) {
      const v = countByDate.get(d);
      if (typeof v === 'number') { count += v; knownDays += 1; }
      else unknownDays += 1;
    }
    return {
      weekStart: w.weekStart, weekEnd: w.weekEnd,
      count, knownDays, unknownDays,
      partial: unknownDays > 0,
      cap: opts.weeklyPublishCap,
      // 하한이 이미 상한을 넘으면 위반은 확정이다. 모르는 날이 있어도 마찬가지.
      violated: count > opts.weeklyPublishCap,
    };
  });
}
