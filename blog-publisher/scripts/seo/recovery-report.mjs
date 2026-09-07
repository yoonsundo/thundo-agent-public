#!/usr/bin/env node
/**
 * seo/recovery-report.mjs — 스팸 조치 회복 계측 주간 리포트 (읽기 전용)
 *
 * 왜 있는가: 2026-08 구글 스팸 업데이트 이후 노출이 절벽처럼 끊겼고(주 63.8 → 주 2.6),
 * 1차 조치(주 3편 감축 · 사람 승인 관문 · 조작 1인칭 차단 게이트)를 배포했다.
 * 그런데 **회복을 볼 수 있는 지표가 없었다.** 회복은 노출보다 "노출을 받는 페이지 수"에서
 * 먼저 보이는데, 그 숫자를 아무도 모으지 않았다. 이 리포트가 그 자리다.
 *
 * 왜 cohort-report 에 넣지 않았나: cohort-report 는 표본이 부족하면 중간에 `return` 해서
 * 리포트를 잘라낸다(적용 이벤트 없음 · 코호트 3편 미만). 지금이 정확히 그 상태다 —
 * 회복 지표를 거기 넣으면 **가장 필요한 시기에 사라진다.** 그래서 별도 생성기로 두고
 * 주간 체인(seo-weekly-cron.sh)의 첫 단계로 돌린다.
 *
 * 입력(전부 기존 산출물 — 새 수집을 만들지 않는다):
 *   state/seo-metrics.jsonl      GSC 일별 노출·클릭 (page·query 차원)
 *   state/naver-rank.jsonl       네이버 타겟 쿼리 순위
 *   published/*.md               발행물(분모·조작표현 스캔 대상)
 *   runs/<date>/run.json         발행 편수(record-publish.mjs 가 결정론으로 기록)
 *   state/index-coverage.jsonl   URL Inspection 색인 상태 (index-inspect.mjs, 있으면)
 *
 * 출력:
 *   docs/reports/seo/recovery-<YYYY-MM-DD>.md   사람이 읽는 리포트
 *   state/seo-recovery.json                     같은 내용의 기계 판독용 스냅샷
 *
 * 사용: node scripts/seo/recovery-report.mjs [YYYY-MM-DD] [--dry-run]
 * exit: 0=정상(지표가 나빠도 0 — 이건 계측이지 게이트가 아니다) / 2=실행오류
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSeoMetrics, collectionWindow } from './gsc-collect.mjs';
import { loadPosts, slugFromUrl } from './stale-content.mjs';
import { evaluate as firsthandEvaluate } from '../gates/check-firsthand.mjs';
import { isMainModule } from '../lib/main-module.mjs';
import { makeLogger } from '../lib/log.mjs';
import { kstDate } from '../kernel/clock.mjs';
import * as M from './recovery-metrics.mjs';

const log = makeLogger('seo/recovery');

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, '../../');

/** 리포트에 그리는 주 수. 절벽(8/17)이 화면에 남을 만큼은 길게. */
const WEEKS_SHOWN = 10;

/** 기준선 구간 — 계획이 인용한 세 수치(63.8 / 41.1 / 2.6)가 나오는 구간 그대로다.
 *  값을 상수로 박지 않고 매번 데이터에서 다시 계산한다. 산식이 바뀌면 여기 숫자가
 *  바뀌므로, 테스트가 문서의 값과 대조해 조용한 변경을 잡는다. */
export const BASELINE_WINDOWS = [
  { label: '스팸 조치 전',   from: '2026-07-04', to: '2026-07-31' },
  { label: '하락 구간',      from: '2026-08-01', to: '2026-08-16' },
  { label: '절벽 이후',      from: '2026-08-17', to: '2026-09-04' },
];

// ── 로더 ────────────────────────────────────────────────────────────────────

function readJsonl(path) {
  if (!existsSync(path)) return null;                 // null = 파일 없음(빈 파일과 다르다)
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* 손상 줄 스킵 */ }
  }
  return out;
}

/**
 * runs/<date>/run.json 에서 날짜별 발행 편수.
 *
 * ⚠ 값이 **null 이면 "기록이 없다"**이고 0("그날 발행 안 함")과 다르다.
 * run.json 은 오랫동안 LLM 이 손으로 썼고 `published` 가 정수였던 날도 있다
 * (record-publish.mjs 주석 참조). 모양이 안 맞는 날을 0 으로 세면 "발행 0편"이라는
 * 거짓 사실이 지표에 들어간다 — 실제로 이사회 브리핑이 그렇게 오독했다.
 */
export function publishCountsFromRuns(runsDir) {
  const map = new Map();
  if (!existsSync(runsDir)) return map;
  for (const d of readdirSync(runsDir)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const p = join(runsDir, d, 'run.json');
    if (!existsSync(p)) { map.set(d, null); continue; }
    let run;
    try { run = JSON.parse(readFileSync(p, 'utf8')); }
    catch { map.set(d, null); continue; }
    map.set(d, Array.isArray(run.published) ? run.published.length : null);
  }
  return map;
}

/** published/ 파일명 날짜에서 뽑은 날짜별 편수. run.json 의 교차검증용(파일은 거짓말하지 않는다). */
export function publishCountsFromFiles(posts) {
  const map = new Map();
  for (const p of posts) {
    if (!p.date) continue;
    map.set(p.date, (map.get(p.date) || 0) + 1);
  }
  return map;
}

/** 조작 1인칭 표현 스캔. 게이트를 인프로세스로 부른다(203편에 0.1초). */
export function scanFirsthand(posts) {
  let violations = 0, errors = 0;
  const worst = [];
  for (const p of posts) {
    let r;
    try { r = firsthandEvaluate(p.file); }
    catch { errors += 1; continue; }
    if (!r.pass) {
      violations += 1;
      worst.push({ slug: p.slug, date: p.date, claims: (r.evidence && r.evidence.claim_count) || 0 });
    }
  }
  worst.sort((a, b) => b.claims - a.claims || (b.date || '').localeCompare(a.date || ''));
  return { scanned: posts.length, violations, errors, worst: worst.slice(0, 10) };
}

// ── 조립 ────────────────────────────────────────────────────────────────────

export function buildSnapshot({ today, metricsRecords, naverRecords, posts, runCounts, indexRecords }) {
  const attempted = M.attemptedDates(metricsRecords, collectionWindow);
  const daily     = M.dailySeries(metricsRecords, attempted);
  const weeksAll  = M.weeklyRollup(daily);
  const weeks     = weeksAll.slice(-WEEKS_SHOWN);

  const bySlugAll = M.aggregateBlogExposure(metricsRecords, slugFromUrl);

  // 커버리지 시점 = GSC 주 경계 + **오늘**. 마지막 GSC 주(레코드가 끝나는 주)로만 끊으면
  // 그 뒤에 발행된 글이 분모에서 빠져 "56/200" 처럼 오늘의 실측(56/203)과 어긋난다.
  const covPoints = weeksAll.map(w => ({ weekEnd: w.weekEnd }));
  const lastWeekEnd = weeksAll.length ? weeksAll[weeksAll.length - 1].weekEnd : null;
  if (!lastWeekEnd || today > lastWeekEnd) covPoints.push({ weekEnd: today, isToday: true });
  const coverage  = M.coverageSeries(bySlugAll, posts, covPoints)
    .map((r, i) => ({ ...r, isToday: !!covPoints[i].isToday }));

  const recovery  = M.recoveryStatus(weeksAll, today);
  const baselines = BASELINE_WINDOWS.map(b => ({ ...b, ...M.windowRate(daily, b.from, b.to) }));

  const position  = M.positionAlarm(M.medianAvgPosition(bySlugAll));
  const naver     = M.naverSnapshot(naverRecords || []);

  // 발행·조작표현은 달력 사실이라 GSC 주(2~3일 지연)가 아니라 **오늘 기준 주**로 센다.
  // GSC 주로 세면 "이번 주"가 사실 지난주가 되어 오늘 발행분이 상한 감시에서 빠진다.
  const calWeeks    = M.recentWeeks(today, WEEKS_SHOWN);
  const publishRun  = M.weeklyPublishCounts(runCounts, calWeeks);
  const fileCounts  = publishCountsFromFiles(posts);
  const publishFile = M.weeklyPublishCounts(fileCounts, calWeeks);

  const firsthand = scanFirsthand(posts);
  const recentFrom = M.mondayOf(today);
  const firsthandRecent = scanFirsthand(posts.filter(p => p.date && p.date >= recentFrom));

  return {
    generated_at: new Date().toISOString(),
    today,
    gsc: {
      coverage_note: '레코드 없는 날은 수집 런의 조회 구간(collectionWindow)에 들면 0회, 아니면 null(모름)',
      first_date: daily.length ? daily[0].date : null,
      last_date:  daily.length ? daily[daily.length - 1].date : null,
      unknown_days: daily.filter(d => !d.known).map(d => d.date),
      weeks,
      baselines,
      recovery,
    },
    exposure_coverage: {
      latest: coverage.length ? coverage[coverage.length - 1] : null,
      series: coverage.slice(-WEEKS_SHOWN),
    },
    position,
    naver,                       // 🔴 구글 지표와 합산 금지 — 다른 엔진, 다른 표본(글이 아니라 쿼리)
    publish: { from_run_json: publishRun, from_files: publishFile, cap: M.THRESHOLDS.weeklyPublishCap },
    firsthand: { all: firsthand, recent_week: { from: recentFrom, ...firsthandRecent } },
    index_coverage: summarizeIndex(indexRecords),
  };
}

/** URL Inspection 산출물 요약. 파일이 없으면 **null(미수집)** — 0 건과 구분한다. */
export function summarizeIndex(indexRecords) {
  if (!indexRecords || !indexRecords.length) return null;
  const last = indexRecords[indexRecords.length - 1];
  const results = last.results || [];
  const by = new Map();
  for (const r of results) by.set(r.verdict || 'UNKNOWN', (by.get(r.verdict || 'UNKNOWN') || 0) + 1);
  const notIndexed = results.filter(r => r.verdict !== 'PASS')
    .map(r => ({ slug: r.slug, verdict: r.verdict, coverageState: r.coverageState }));
  return {
    collected_at: last.collected_at,
    checked: results.length,
    requested: last.requested ?? results.length,
    indexed: by.get('PASS') || 0,
    verdicts: Object.fromEntries(by),
    not_indexed: notIndexed.slice(0, 20),
    not_indexed_total: notIndexed.length,
    incomplete_reason: last.incomplete_reason || null,
  };
}

// ── 마크다운 ────────────────────────────────────────────────────────────────

function num(v, digits = 1) { return v == null ? '측정 못 함' : Number(v).toFixed(digits); }

export function renderReport(s) {
  const L = [];
  const rec = s.gsc.recovery;

  L.push(`# 스팸 조치 회복 계측 — ${s.today}`);
  L.push('');
  L.push('> 자동 생성: `scripts/seo/recovery-report.mjs` (읽기 전용 · 기존 산출물만 사용)');
  L.push('> 🔴 **구글과 네이버 수치를 합산하지 않는다.** 다른 엔진이고 표본 정의도 다르다.');
  L.push('> 표에서 `측정 못 함` 은 0 이 아니다 — 그날 수집이 시도되지 않았다는 뜻이다.');
  L.push('');

  // ── 판정 요약 ──
  L.push('## 판정 요약');
  L.push('');
  L.push('| 지표 | 현재 | 판정선 | 상태 |');
  L.push('|------|------|--------|------|');

  const cov = s.exposure_coverage.latest;
  // 직전 시점과의 증분은 마지막 구간이 하루짜리(오늘)라 거의 항상 0 이다.
  // 회복 신호로 읽을 수 있는 건 4주 폭의 분자 증가다.
  const covSeries = s.exposure_coverage.series;
  const cov4 = covSeries.length >= 5 ? covSeries[covSeries.length - 5] : covSeries[0];
  const cov4Delta = cov && cov4 ? cov.exposed - cov4.exposed : null;
  L.push(`| 노출 받은 고유 blog URL (누적) | ${cov ? `${cov.exposed} / ${cov.total}` : '측정 못 함'} | 4주 전 대비 분자가 늘어야 함 | ${cov4Delta == null ? '—' : cov4Delta > 0 ? `📈 +${cov4Delta}편` : cov4Delta === 0 ? '➖ 증가 없음' : `📉 ${cov4Delta}편`} |`);

  const lastWeek = rec.lastCompleteWeek;
  L.push(`| 구글 주간 노출 (직전 완료 주) | ${lastWeek ? `${lastWeek.impressions}회${lastWeek.partial ? ' (하한)' : ''}` : '측정 못 함'} | 주 ${rec.threshold}회 이상 × ${rec.needed}주 연속 | ${rec.recovered ? '✅ 회복' : `❌ 미달 (연속 ${rec.streak}/${rec.needed}주)`} |`);

  L.push(`| 노출 글 평균순위 중앙값 | ${num(s.position.median, 1)}위 | ${num(s.position.limit, 1)}위 넘으면 경보 | ${s.position.status === 'alarm' ? '🚨 경보' : s.position.status === 'unknown' ? '측정 못 함' : '✅ 정상'} |`);

  L.push(`| 네이버 노출 쿼리 수 | ${s.naver.date ? `${s.naver.exposedQueries} / ${s.naver.totalQueries}` : '측정 못 함'} | (구글과 별개 · 합산 금지) | ${s.naver.date ? `${s.naver.date} 기준` : '—'} |`);

  const pubWeeks = s.publish.from_files;
  const lastPub = pubWeeks.length ? pubWeeks[pubWeeks.length - 1] : null;
  const violCount = pubWeeks.filter(w => w.violated).length;
  L.push(`| 주간 발행 편수 (이번 주 ${lastPub ? lastPub.weekStart : '—'}~) | ${lastPub ? `${lastPub.count}편` : '측정 못 함'} | 상한 주 ${s.publish.cap}편 | ${lastPub && lastPub.violated ? '❌ 이번 주 초과' : violCount > 0 ? `⚠ 최근 ${pubWeeks.length}주 중 ${violCount}주 초과(조치 전 이력 포함)` : '✅ 상한 이내'} |`);

  L.push(`| 조작 1인칭 표현 발행물 | ${s.firsthand.all.violations} / ${s.firsthand.all.scanned}편 | 0편 | ${s.firsthand.all.violations === 0 ? '✅ 없음' : '❌ 잔존'} |`);

  const ix = s.index_coverage;
  L.push(`| 색인된 페이지 (URL Inspection) | ${ix ? `${ix.indexed} / ${ix.checked}` : '측정 못 함 (미수집)'} | 분자가 늘어야 함 | ${ix ? `${String(ix.collected_at).slice(0, 10)} 기준` : '`npm run seo:index-inspect`'} |`);
  L.push('');

  // ── 1. 노출 커버리지 ──
  L.push('## 1. 노출을 한 번이라도 받은 고유 blog URL (누적)');
  L.push('');
  L.push('회복은 노출 총량보다 **몇 편이 검색에 잡히는가**에서 먼저 보인다. 그래서 이 지표가 첫 칸이다.');
  L.push('');
  L.push('⚠ **비율만 보면 안 된다.** 1차 조치로 발행이 주 3편으로 줄어 분모 증가가 거의 멈춘다.');
  L.push('그러면 분자가 그대로여도 비율이 안 오르고, 분자가 조금만 늘어도 비율이 크게 오른다.');
  L.push('아래 표는 분자·분모와 **각각의 증분**을 따로 싣는다. 비율은 참고값이다.');
  L.push('');
  L.push('| 주 종료일 | 노출 받은 글(분자) | 발행물(분모) | 비율 | 분자 증분 | 분모 증분 |');
  L.push('|-----------|-------------------|--------------|------|-----------|-----------|');
  for (const r of s.exposure_coverage.series) {
    L.push(`| ${r.at}${r.isToday ? " (오늘)" : ""} | ${r.exposed} | ${r.total} | ${r.ratio == null ? '—' : (r.ratio * 100).toFixed(1) + '%'} | ${r.exposedDelta == null ? '—' : (r.exposedDelta >= 0 ? '+' : '') + r.exposedDelta} | ${r.totalDelta == null ? '—' : (r.totalDelta >= 0 ? '+' : '') + r.totalDelta} |`);
  }
  L.push('');

  // ── 2. 주간 노출 ──
  L.push('## 2. 구글 주간 노출 합계 (회복 판정선)');
  L.push('');
  L.push(`**판정선 = 주 ${rec.threshold}회 이상이 ${rec.needed}주 연속.** 일별은 잡음이라 주 단위로만 본다.`);
  L.push('');
  L.push('기준선(같은 산식으로 매번 재계산):');
  L.push('');
  L.push('| 구간 | 기간 | 노출 합계 | 주당 환산 | 미측정일 |');
  L.push('|------|------|-----------|-----------|----------|');
  for (const b of s.gsc.baselines) {
    L.push(`| ${b.label} | ${b.from} ~ ${b.to} | ${b.impressions} | ${num(b.perWeek, 1)} | ${b.unknownDays} |`);
  }
  L.push('');
  L.push('| 주 (월~일) | 노출 | 클릭 | 측정된 날 | 판정선 |');
  L.push('|------------|------|------|-----------|--------|');
  for (const w of s.gsc.weeks) {
    const met = w.impressions >= rec.threshold;
    const flag = met ? '✅' : (w.partial ? '❔ (하한 미달)' : '❌');
    L.push(`| ${w.weekStart} ~ ${w.weekEnd} | ${w.impressions}${w.partial ? ' (하한)' : ''} | ${w.clicks} | ${w.knownDays}/${w.coveredDays} | ${flag} |`);
  }
  L.push('');
  L.push(`현재 연속 달성: **${rec.streak}주 / ${rec.needed}주** → ${rec.recovered ? '**회복 판정 충족**' : '**미달**'}`);
  if (s.gsc.unknown_days.length) {
    L.push('');
    L.push(`⚠ 수집이 시도되지 않아 **모르는 날** ${s.gsc.unknown_days.length}일: ${s.gsc.unknown_days.join(', ')}`);
    L.push('이 날들의 노출은 0회가 아니라 미측정이다. 그 주 합계는 하한으로 읽어야 한다.');
  }
  L.push('');

  // ── 3. 평균순위 ──
  L.push('## 3. 노출된 글의 평균순위 중앙값 (경보 지표)');
  L.push('');
  L.push('⚠ **올릴 목표가 아니다.** 노출을 받는 글이 늘면 이 값은 오히려 나빠질 수 있다(새로 잡힌 글은 대개 뒤쪽 순위).');
  L.push('여기서 보는 건 "이미 잡히던 글들이 뒤로 밀리고 있지 않은가" 하나다.');
  L.push('');
  L.push(`- 현재 중앙값: **${num(s.position.median, 2)}위** (기준선 ${num(s.position.baseline ?? M.THRESHOLDS.positionBaseline, 1)}위)`);
  L.push(`- 경보선: ${num(s.position.limit, 1)}위 초과 → ${s.position.status === 'alarm' ? '🚨 **경보**' : '현재 정상'}`);
  L.push('');

  // ── 4. 네이버 ──
  L.push('## 4. 네이버 노출 쿼리 수 (별도 엔진)');
  L.push('');
  L.push('🔴 구글 수치와 **절대 합산하지 않는다.** 표본이 "글"이 아니라 "타겟 쿼리"이고, 순위 `null` 은');
  L.push('"순위 없음"이 아니라 display 상한(30) 밖이라 **모르는 것**이다.');
  L.push('');
  if (s.naver.date) {
    L.push(`- 수집일 ${s.naver.date} · 노출 **${s.naver.exposedQueries} / ${s.naver.totalQueries} 쿼리**`);
    for (const e of s.naver.exposed) L.push(`  - ${e.rank}위 (${e.type}) — \`${e.query}\``);
  } else {
    L.push('- 측정 못 함 (state/naver-rank.jsonl 없음 또는 비어 있음)');
  }
  L.push('');

  // ── 5. 발행 편수 ──
  L.push('## 5. 주간 발행 편수 (상한 주 3편)');
  L.push('');
  L.push('⚠ **늘릴 목표가 아니다.** 넘으면 그 자체가 1차 조치 실패다.');
  L.push('');
  L.push('run.json 이 정본이지만 `record-publish.mjs` 도입(2026-09-07) 전 기록은 모양이 흔들린다.');
  L.push('그래서 파일명 기준 편수를 나란히 싣는다 — 둘이 어긋나면 기록 쪽을 의심한다.');
  L.push('');
  L.push('| 주 (월~일) | run.json | published/ 파일 | 상한 | 판정 |');
  L.push('|------------|----------|-----------------|------|------|');
  for (let i = 0; i < s.publish.from_files.length; i++) {
    const f = s.publish.from_files[i];
    const r = s.publish.from_run_json[i];
    const runCell = r ? (r.knownDays === 0 ? '측정 못 함' : `${r.count}${r.partial ? ` (${r.unknownDays}일 미기록)` : ''}`) : '측정 못 함';
    L.push(`| ${f.weekStart} ~ ${f.weekEnd} | ${runCell} | ${f.count} | ${f.cap} | ${f.violated ? '❌ 초과' : '✅'} |`);
  }
  L.push('');

  // ── 6. 조작 1인칭 ──
  L.push('## 6. 조작 1인칭 표현이 든 발행물 (목표 0)');
  L.push('');
  L.push('작가 에이전트는 Read·Write 만 가진다 — 도구를 돌려볼 수도, 시간을 잴 수도 없다.');
  L.push('그런데 "직접 돌려봤더니 48초" 같은 문장이 발행됐다. 8월 스팸 업데이트의 표적이 정확히 이 프로필이다.');
  L.push('');
  L.push(`- 전체 발행물: **${s.firsthand.all.violations} / ${s.firsthand.all.scanned}편** 에 조작 표현${s.firsthand.all.errors ? ` (읽기 실패 ${s.firsthand.all.errors}편)` : ''}`);
  L.push(`- 이번 주 발행분(${s.firsthand.recent_week.from} 이후): **${s.firsthand.recent_week.violations} / ${s.firsthand.recent_week.scanned}편**`);
  L.push('');
  L.push('전체 수치는 게이트 도입 이전 재고이므로 즉시 0 이 되지 않는다. 매주 봐야 하는 것은 **이번 주 발행분 0편**이다.');
  if (s.firsthand.all.worst.length) {
    L.push('');
    L.push('가장 많이 걸린 글:');
    L.push('');
    L.push('| 발행일 | slug | 주장 수 |');
    L.push('|--------|------|---------|');
    for (const w of s.firsthand.all.worst) L.push(`| ${w.date || '—'} | \`${w.slug}\` | ${w.claims} |`);
  }
  L.push('');

  // ── 7. 색인 ──
  L.push('## 7. 색인 상태 (Search Console URL Inspection)');
  L.push('');
  if (!ix) {
    L.push('**측정 못 함 — 아직 수집한 적이 없다.** (0건이 아니라 데이터 부재다.)');
    L.push('');
    L.push('수집: `npm run seo:index-inspect` — 기존 GSC 서비스계정으로 동작이 확인돼 있다.');
  } else {
    L.push(`- 수집: ${ix.collected_at} · 조회 ${ix.checked} / 요청 ${ix.requested}`);
    L.push(`- **색인됨(PASS): ${ix.indexed} / ${ix.checked}**`);
    L.push(`- verdict 분포: ${Object.entries(ix.verdicts).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
    if (ix.incomplete_reason) L.push(`- ⚠ 부분 수집: ${ix.incomplete_reason} (나머지는 0 이 아니라 미조회다)`);
    if (ix.not_indexed_total) {
      L.push('');
      L.push(`색인 안 된 글 ${ix.not_indexed_total}편 중 상위 ${ix.not_indexed.length}편:`);
      L.push('');
      L.push('| slug | verdict | 상태 |');
      L.push('|------|---------|------|');
      for (const n of ix.not_indexed) L.push(`| \`${n.slug}\` | ${n.verdict} | ${n.coverageState || '—'} |`);
    }
  }
  L.push('');
  L.push('---');
  L.push(`*생성: ${s.generated_at} · scripts/seo/recovery-report.mjs*`);
  return L.join('\n');
}

// ── 메인 ────────────────────────────────────────────────────────────────────

export function run({ today = kstDate(new Date()), root = REPO_ROOT, dryRun = false } = {}) {
  const metricsRecords = [...loadSeoMetrics(join(root, 'state', 'seo-metrics.jsonl')).values()];
  const naverRecords   = readJsonl(join(root, 'state', 'naver-rank.jsonl')) || [];
  const indexRecords   = readJsonl(join(root, 'state', 'index-coverage.jsonl'));
  const posts          = loadPosts();
  const runCounts      = publishCountsFromRuns(join(root, 'runs'));

  const snapshot = buildSnapshot({ today, metricsRecords, naverRecords, posts, runCounts, indexRecords });
  const md = renderReport(snapshot);

  if (dryRun) return { snapshot, md, outPath: null };

  const outDir = join(root, 'docs', 'reports', 'seo');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `recovery-${today}.md`);
  writeFileSync(outPath, md + '\n', 'utf8');

  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'state', 'seo-recovery.json'), JSON.stringify(snapshot, null, 2) + '\n', 'utf8');

  return { snapshot, md, outPath };
}

if (isMainModule(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const today = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || kstDate(new Date());
    const dryRun = args.includes('--dry-run');
    const { snapshot, outPath } = run({ today, dryRun });
    const r = snapshot.gsc.recovery;
    const cov = snapshot.exposure_coverage.latest;
    log.info(`노출 커버리지 ${cov ? `${cov.exposed}/${cov.total}` : 'n/a'} · 회복 연속 ${r.streak}/${r.needed}주 · 조작표현 ${snapshot.firsthand.all.violations}편`);
    console.log(dryRun ? '[recovery-report] (dry-run) 파일 미기록' : `[recovery-report] ✅ ${outPath}`);
    process.exit(0);
  } catch (e) {
    log.error(`치명 오류: ${e.message}`);
    process.exit(2);
  }
}
