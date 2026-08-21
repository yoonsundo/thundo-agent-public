/**
 * shorts-curiosity/analytics-report.mjs — 유튜브 반응 리포트 + 일일 브리핑 (호기심 채널)
 *
 * state/shorts-curiosity/analytics.jsonl 의 스냅샷(조회·좋아요·댓글)을 영상별 시계열로 묶어
 * 최신값·전일대비·전주대비를 계산하고, channel-stats.jsonl 의 구독자 시계열로
 * **구독 500 목표까지 남은 수와 도달 ETA**를 산출한다.
 *   → docs/reports/shorts/curiosity-analytics-<date>.md 저장
 *   → Telegram/Discord 로 브리핑 실발송(NOTIFY_FORCE_LIVE=1, 발송 결과는 반환값 sent 로 확인)
 *
 * ⚠ yt-analytics.readonly 미동의 상태라 트래픽소스·시청지속·구독전환 등 상세 지표는 범위 밖 —
 * analytics-collect.mjs가 수집하는 공개 지표(조회·좋아요·댓글·구독자)만 다룬다.
 *
 * env:
 *   CURIOSITY_ANALYTICS_REPORT_DIR — 리포트 출력 디렉토리(테스트 격리용)
 *   CURIOSITY_ANALYTICS_DRYRUN=1   — 알림 발송 생략(테스트, naver-rank-report 의 DRYRUN 관례)
 *   CURIOSITY_SUBSCRIBER_GOAL      — 구독 목표(기본 config 또는 500)
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeLogger } from '../lib/log.mjs';
import { computeMetrics, renderMetrics, kstDay } from './metrics.mjs';
import { paths } from '../lib/config.mjs';
import { notify } from '../notify/index.mjs';

import { isMainModule } from '../lib/main-module.mjs';
const log = makeLogger('curiosity-analytics-report');

const ANALYTICS_PATH = join(paths.state, 'shorts-curiosity', 'analytics.jsonl');
const CHANNEL_STATS_PATH = join(paths.state, 'shorts-curiosity', 'channel-stats.jsonl');
// mock 런이 docs/ 를 오염시키지 않도록 격리(paths.runs 의 mock 격리 규약과 동일).
const REPORT_DIR = process.env.CURIOSITY_ANALYTICS_REPORT_DIR
  || (process.env.RUN_MODE === 'mock'
    ? join(paths.mockOut, 'reports', 'shorts')
    : join(paths.root, 'docs', 'reports', 'shorts'));
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const DEFAULT_GOAL = 500;

/**
 * 브리핑 이벤트명. notify/index.mjs 의 EVENTS 에는 아직 전용 타입이 없고 그 파일은 이 작업의
 * 수정 범위 밖이라 지역 상수로 둔다(notify() 는 임의 이벤트 문자열을 그대로 렌더한다).
 */
const EVENT_BRIEF = 'CURIOSITY_ANALYTICS_BRIEF';

function readJsonl(p) {
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/**
 * live 런은 mock 합성 레코드(mock:true)를 무시한다 — mock 검증 런이 같은 jsonl 에 append 하므로
 * 걸러내지 않으면 합성 수치가 실 추세(구독 ETA·전일대비)에 섞인다.
 */
function keepReal(rows) {
  return process.env.RUN_MODE === 'mock' ? rows : rows.filter(r => !r.mock);
}
function loadSnapshots() { return keepReal(readJsonl(ANALYTICS_PATH)); }
function loadChannelStats() {
  return keepReal(readJsonl(CHANNEL_STATS_PATH)).filter(s => s.ts).sort((a, b) => a.ts.localeCompare(b.ts));
}

/** 구독 목표 — env > config(analytics.subscriber_goal / goal.subscribers) > 500. */
function subscriberGoal() {
  const fromEnv = parseInt(process.env.CURIOSITY_SUBSCRIBER_GOAL || '', 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  try {
    const p = process.env.CURIOSITY_CONFIG_OVERRIDE || join(paths.root, 'config', 'shorts-curiosity.json');
    const cfg = JSON.parse(readFileSync(p, 'utf8'));
    const g = cfg?.analytics?.subscriber_goal ?? cfg?.goal?.subscribers;
    if (Number.isFinite(g) && g > 0) return g;
  } catch { /* config 없거나 키 없음 → 기본값 */ }
  return DEFAULT_GOAL;
}

/** youtube_id별 스냅샷 시계열(ts 오름차순) Map. */
function groupById(snapshots) {
  const map = new Map();
  for (const s of snapshots) {
    if (!s.youtube_id || !s.ts) continue;
    if (!map.has(s.youtube_id)) map.set(s.youtube_id, []);
    map.get(s.youtube_id).push(s);
  }
  for (const arr of map.values()) arr.sort((a, b) => a.ts.localeCompare(b.ts));
  return map;
}

/** 영상별 최신 스냅샷 + ~7일전/전일 대비 증감. */
export function buildRows(byId) {
  const rows = [];
  for (const [youtube_id, series] of byId) {
    const latest = series[series.length - 1];
    const latestTs = new Date(latest.ts).getTime();
    const prior = [...series].reverse().find(s => (latestTs - new Date(s.ts).getTime()) >= WEEK_MS);
    // 전일대비: 최신 스냅샷보다 **날짜(UTC 기준 ts 앞 10자)가 이전인** 가장 최근 스냅샷.
    // 같은 날 여러 번 수집돼도 하루 단위로 비교된다.
    const latestDay = String(latest.ts).slice(0, 10);
    const yday = [...series].reverse().find(s => String(s.ts).slice(0, 10) < latestDay);
    rows.push({
      youtube_id,
      subject: latest.subject || latest.title || youtube_id,
      title: latest.title || null,
      views: latest.views ?? null, likes: latest.likes ?? null, comments: latest.comments ?? null,
      ts: latest.ts,
      deltaViews: (prior && prior.views != null && latest.views != null) ? latest.views - prior.views : null,
      dailyViews: (yday && yday.views != null && latest.views != null) ? latest.views - yday.views : null,
      priorTs: prior ? prior.ts : null,
      ydayTs: yday ? yday.ts : null,
      snapshotCount: series.length,
    });
  }
  rows.sort((a, b) => (b.views ?? -1) - (a.views ?? -1));
  return rows;
}

/** 채널 전체 전일대비 조회 델타 — 전일 스냅샷이 있는 영상만 합산(없으면 null). */
export function buildDailyDelta(rows) {
  const usable = rows.filter(r => r.dailyViews != null);
  if (usable.length === 0) return { delta: null, videos: 0, priorTs: null };
  return {
    delta: usable.reduce((a, r) => a + r.dailyViews, 0),
    videos: usable.length,
    priorTs: usable.map(r => r.ydayTs).sort().reverse()[0] || null,
  };
}

/**
 * 구독자 현황 + 목표까지 남은 수 + 최근 7일 증가속도 기반 ETA.
 * 표본이 1개거나(24시간 미만 간격) 증가가 0/감소면 정직하게 "산출불가".
 */
export function buildChannelSummary(series, goal = DEFAULT_GOAL) {
  const usable = (series || []).filter(s => s.subscribers != null);
  if (usable.length === 0) {
    return { available: false, goal, subscribers: null, remaining: null, growth: null, perDay: null, etaText: '산출불가(구독자 스냅샷 없음)' };
  }
  const latest = usable[usable.length - 1];
  const latestT = new Date(latest.ts).getTime();
  const remaining = Math.max(0, goal - latest.subscribers);

  // 24시간 이상 이전 표본만 속도 계산에 쓴다(같은 날 중복 수집으로 속도가 폭주하는 걸 방지).
  const older = usable.filter(s => (latestT - new Date(s.ts).getTime()) >= DAY_MS);
  const within = older.filter(s => (latestT - new Date(s.ts).getTime()) <= WEEK_MS);
  const baseline = within.length ? within[0] : (older.length ? older[older.length - 1] : null);

  const base = {
    available: true, goal, subscribers: latest.subscribers, remaining,
    views: latest.views ?? null, videos: latest.videos ?? null,
    ts: latest.ts, hidden: !!latest.subscribers_hidden,
  };

  if (remaining === 0) return { ...base, growth: null, perDay: null, days: null, etaText: `목표 ${goal.toLocaleString('ko-KR')}명 달성` };
  if (!baseline) return { ...base, growth: null, perDay: null, days: null, etaText: '산출불가(표본 부족 — 24시간 이상 간격 스냅샷 필요)' };

  const days = (latestT - new Date(baseline.ts).getTime()) / DAY_MS;
  const growth = latest.subscribers - baseline.subscribers;
  const perDay = days > 0 ? growth / days : 0;

  if (perDay <= 0) {
    return { ...base, growth, perDay, days, baselineTs: baseline.ts, etaText: `산출불가(최근 ${days.toFixed(1)}일 증가 ${growth}명 — 정체/감소)` };
  }
  const etaDays = Math.ceil(remaining / perDay);
  const etaDate = new Date(latestT + etaDays * DAY_MS).toISOString().slice(0, 10);
  return {
    ...base, growth, perDay, days, baselineTs: baseline.ts, etaDays, etaDate,
    etaText: `약 ${etaDays.toLocaleString('ko-KR')}일 후(${etaDate}) 도달 예상`,
  };
}

const n = (v) => (v == null ? '-' : Number(v).toLocaleString('ko-KR'));

/**
 * 가드레일 위반만 한 줄씩. 정상·산출불가는 아무것도 내지 않는다.
 * Telegram Markdown 을 깨지 않도록 `*` `_` `[` 를 쓰지 않는다(브리핑 계약).
 */
export function breachLines(guardrails) {
  const g = guardrails || {};
  const out = [];
  for (const key of ['continuity', 'diversity', 'repeat']) {
    const r = g[key];
    if (r && r.status === 'ok' && r.breach && r.note) out.push(`경고 — ${r.note}`);
  }
  return out;
}

/**
 * 알림·리포트 공용 브리핑 본문(평문). Telegram parse_mode=Markdown 을 깨지 않도록
 * `*` `_` `[` 를 쓰지 않는다.
 */
export function buildBriefing({ rows, channel, daily, today, mock = false, guardrails = null }) {
  const lines = [`호기심 쇼츠 채널 일일 브리핑 (${today})${mock ? ' [mock 합성]' : ''}`];

  // 가드레일 위반은 **맨 위에** 둔다. 리포트 파일에만 적으면 아무도 안 본다 —
  // 조회수 수집 실패가 07-30부터 매일 경보를 냈는데도 한 달간 방치된 게 그 증거다.
  // 정상일 때는 한 줄도 늘리지 않는다(조용해야 위반이 눈에 띈다).
  for (const line of breachLines(guardrails)) lines.push(line);

  // 구독자 / 500 목표 / ETA
  if (channel.available) {
    lines.push(`구독자 ${n(channel.subscribers)}명 · 목표 ${n(channel.goal)}명까지 ${n(channel.remaining)}명 남음`);
    const speed = channel.perDay != null && channel.days != null
      ? `최근 ${channel.days.toFixed(1)}일 증가 ${channel.growth > 0 ? '+' : ''}${n(channel.growth)}명(일 ${channel.perDay.toFixed(1)}명) → `
      : '';
    lines.push(`${speed}${channel.etaText}`);
    if (channel.views != null) lines.push(`채널 누적 조회 ${n(channel.views)} · 영상 ${n(channel.videos)}편`);
  } else {
    lines.push(`구독자 수집 데이터 없음 — 목표 ${n(channel.goal)}명 대비 진척 산출불가(channel-stats.jsonl 미생성)`);
  }

  // 조회수 전일대비
  const totalViews = rows.reduce((a, r) => a + (r.views || 0), 0);
  if (rows.length === 0) {
    lines.push('성과 학습 중단 — 영상 스냅샷 0건이라 소재·앵글·길이 최적화가 작동하지 않음(analytics-collect 복구 필요)');
  } else if (daily.delta == null) {
    lines.push(`추적 ${rows.length}편 · 누적 조회 ${n(totalViews)} (전일 스냅샷 없어 전일대비 산출불가)`);
  } else {
    lines.push(`추적 ${rows.length}편 · 누적 조회 ${n(totalViews)} · 전일대비 ${daily.delta >= 0 ? '+' : ''}${n(daily.delta)} (${daily.videos}편 기준)`);
  }

  // 상위/하위 3편 — 다음 제작 방향 근거
  if (rows.length > 0) {
    const label = (r) => `${(r.title || r.subject || r.youtube_id).slice(0, 48)} (${n(r.views)}회)`;
    lines.push('성과 상위 3편:');
    rows.slice(0, 3).forEach((r, i) => lines.push(`  ${i + 1}. ${label(r)}`));
    const bottom = rows.slice(-3).reverse();
    lines.push('성과 하위 3편:');
    bottom.forEach((r, i) => lines.push(`  ${i + 1}. ${label(r)}`));
  }

  return lines.join('\n');
}

function renderMd(rows, channel, daily, today, briefing, metricsMd = '') {
  const lines = [
    `# 호기심 쇼츠 채널 — 유튜브 반응 리포트 (${today})`,
    '',
    '> 자동 생성: `scripts/shorts-curiosity/analytics-report.mjs` · 공개 Data API v3(videos.list·channels.list) 기반',
    '> ⚠ yt-analytics.readonly 미동의 — 조회수·좋아요·댓글수·구독자만(트래픽소스·시청지속·구독전환 등 상세 지표는 재동의 후 범위)',
    '',
    '## 브리핑 (알림 발송 본문)',
    '',
    '```',
    briefing,
    '```',
    '',
  ];

  // 북극성·가드레일을 구독 목표보다 앞에 둔다 — 매일 처음 보는 것이 이 네 줄이어야 한다.
  // 계측이 0인 상태로 설정을 조여 온 것이 이 채널의 실패 패턴이었다(2026-08-21 분석).
  if (metricsMd) lines.push(metricsMd, '');

  lines.push('## 구독 목표', '');
  if (channel.available) {
    lines.push(`- 구독자 **${n(channel.subscribers)}명** / 목표 ${n(channel.goal)}명 → 남은 ${n(channel.remaining)}명`);
    lines.push(`- 도달 ETA: ${channel.etaText}`);
    if (channel.growth != null) lines.push(`- 최근 ${channel.days.toFixed(1)}일 증가: ${channel.growth > 0 ? '+' : ''}${n(channel.growth)}명 (일 ${channel.perDay.toFixed(1)}명)`);
    if (channel.views != null) lines.push(`- 채널 누적 조회 ${n(channel.views)} · 영상 ${n(channel.videos)}편`);
  } else {
    lines.push(`- 구독자 스냅샷 없음 — 목표 ${n(channel.goal)}명 대비 진척 산출불가. \`npm run curiosity:analytics\` 가 channel-stats.jsonl 을 채워야 한다.`);
  }
  lines.push('');

  if (rows.length === 0) {
    lines.push('## 영상별', '', '⚠ **성과 학습 중단** — 수집 스냅샷이 0건이라 자동 최적화가 작동하지 않습니다. `npm run curiosity:analytics` 수집 경로를 복구해야 합니다.', '');
    return lines.join('\n');
  }

  const totalViews = rows.reduce((a, r) => a + (r.views || 0), 0);
  const totalLikes = rows.reduce((a, r) => a + (r.likes || 0), 0);
  const totalComments = rows.reduce((a, r) => a + (r.comments || 0), 0);
  const hasDelta = rows.some(r => r.deltaViews != null);

  lines.push('## 요약', '');
  lines.push(`- 추적 영상 ${rows.length}편 · 누적 조회 ${n(totalViews)} · 좋아요 ${n(totalLikes)} · 댓글 ${n(totalComments)}`);
  lines.push(daily.delta == null
    ? '- 전일대비 조회 증감: 전일 스냅샷이 없어 산출불가(수집이 하루 1회 이상 돌아야 함)'
    : `- 전일대비 조회 증감: ${daily.delta >= 0 ? '+' : ''}${n(daily.delta)} (${daily.videos}편 기준)`);
  lines.push(hasDelta
    ? '- 전주대비 증감은 ~7일 전 스냅샷 대비(가능한 영상만 계산)'
    : '- 아직 7일치 데이터가 쌓이지 않아 전주대비 증감은 다음 리포트부터 표시됩니다(데이터 축적 중).');
  lines.push('');

  lines.push('## 영상별', '');
  lines.push('| 영상 | 조회 | 좋아요 | 댓글 | 전일대비 | 전주대비(조회) | 스냅샷 |');
  lines.push('|------|------|--------|------|----------|----------------|--------|');
  for (const r of rows) {
    const delta = r.deltaViews == null ? '-' : (r.deltaViews > 0 ? `+${r.deltaViews}` : String(r.deltaViews));
    const dayDelta = r.dailyViews == null ? '-' : (r.dailyViews > 0 ? `+${r.dailyViews}` : String(r.dailyViews));
    const link = `[${r.subject}](https://youtube.com/shorts/${r.youtube_id})`;
    lines.push(`| ${link} | ${n(r.views)} | ${n(r.likes)} | ${n(r.comments)} | ${dayDelta} | ${delta} | ${r.snapshotCount} |`);
  }
  lines.push('');

  lines.push('## 상위/하위 3편 (다음 제작 방향 근거)', '');
  lines.push('상위:');
  for (const r of rows.slice(0, 3)) lines.push(`- **${r.title || r.subject}** — ${n(r.views)}회`);
  lines.push('', '하위:');
  for (const r of rows.slice(-3).reverse()) lines.push(`- ${r.title || r.subject} — ${n(r.views)}회`);
  lines.push('');

  return lines.join('\n');
}

/** RUN_MODE=mock 합성 데이터 — 브리핑 전문(구독/ETA/상하위/전일대비)이 생성되는지 검증용. */
function mockData() {
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const snapshots = [];
  const videos = [
    { youtube_id: 'MOCK1', subject: '바이킹 뿔투구 신화', views: [1200, 1450] },
    { youtube_id: 'MOCK2', subject: '혀의 맛 지도는 틀렸다', views: [800, 860] },
    { youtube_id: 'MOCK3', subject: '금붕어 기억력 3초설', views: [300, 310] },
    { youtube_id: 'MOCK4', subject: '만리장성은 우주에서 안 보인다', views: [150, 152] },
  ];
  for (const v of videos) {
    snapshots.push({ ts: iso(2 * DAY_MS), youtube_id: v.youtube_id, subject: v.subject, title: v.subject, views: v.views[0], likes: Math.round(v.views[0] * 0.04), comments: 3 });
    snapshots.push({ ts: iso(0), youtube_id: v.youtube_id, subject: v.subject, title: v.subject, views: v.views[1], likes: Math.round(v.views[1] * 0.04), comments: 4 });
  }
  const channel = [
    { ts: iso(7 * DAY_MS), subscribers: 120, views: 20000, videos: 47 },
    { ts: iso(0), subscribers: 141, views: 24000, videos: 47 },
  ];
  return { snapshots, channel };
}

async function main() {
  const mock = process.env.RUN_MODE === 'mock';
  const today = new Date().toISOString().slice(0, 10);
  const goal = subscriberGoal();

  let snapshots = loadSnapshots();
  let chanSeries = loadChannelStats();
  let synthesized = false;

  if (mock && (snapshots.length === 0 || chanSeries.length === 0)) {
    const m = mockData();
    if (snapshots.length === 0) snapshots = m.snapshots;
    if (chanSeries.length === 0) chanSeries = m.channel;
    synthesized = true;
    log.info('[mock] 수집 데이터가 얇아 합성 데이터로 브리핑 전문 생성');
  }
  // mock 수집이 남긴 mock:true 레코드를 쓰는 중이면 브리핑에 그 사실을 표시한다(수치 오독 방지).
  if (mock && (snapshots.some(s => s.mock) || chanSeries.some(s => s.mock))) synthesized = true;

  if (snapshots.length === 0) {
    log.warn('성과 학습 중단: state/shorts-curiosity/analytics.jsonl 비었거나 없음 — 브리핑에 차단 상태로 명시');
  }

  const rows = buildRows(groupById(snapshots));
  const daily = buildDailyDelta(rows);
  const channel = buildChannelSummary(chanSeries, goal);
  // 지표 산출이 실패해도 브리핑·리포트는 나가야 한다(비차단 계약).
  let metrics = null, metricsMd = '';
  try {
    // ⚠ 지표 날짜는 **KST** 여야 한다. `today` 는 UTC(`toISOString`)라 02:00 KST 크론에서
    //    항상 하루 전이 되고, 그러면 결방 판정이 그저께까지만 보고 다양성·재탕 창에서
    //    가장 최근 발행일이 빠진다(어제 결방이 나도 오늘 경보가 안 뜬다).
    metrics = computeMetrics({ today: kstDay(new Date().toISOString()), snapshots });
    metricsMd = renderMetrics(metrics);
  } catch (err) {
    log.warn(`지표 산출 실패(리포트는 계속): ${err.message}`);
  }
  const briefing = buildBriefing({ rows, channel, daily, today, mock: synthesized, guardrails: metrics?.guardrails });

  mkdirSync(REPORT_DIR, { recursive: true });
  const docPath = join(REPORT_DIR, `curiosity-analytics-${today}.md`);
  writeFileSync(docPath, renderMd(rows, channel, daily, today, briefing, metricsMd), 'utf8');
  log.info(`리포트 저장: ${docPath} (영상 ${rows.length}편)`);
  console.log(briefing);

  // 브리핑 실발송. 이 박스는 크리덴셜 누락으로 config 가 항상 mock 이라 NOTIFY_FORCE_LIVE=1
  // 없이는 사람에게 도달하지 않는다(notify/live-override.mjs). 결과는 반환값으로 확인한다.
  let delivery = null;
  // RUN_MODE=mock 은 "검증 런"이다 → 합성 수치를 사람 채널로 쏘지 않는다. 실측 2026-07-30:
  // 이 셸에는 TELEGRAM/DISCORD 크리덴셜이 이미 export 돼 있어 mock 런이 그대로 발송됐다.
  // 일일 cron 은 .env 의 RUN_MODE=live 로 돌므로(config 가 mock 으로 강등돼도 이 원본 env 판정은
  // live) 브리핑은 정상 발송된다. 강제 발송이 필요하면 CURIOSITY_ANALYTICS_FORCE_NOTIFY=1.
  const notifyBlocked = process.env.CURIOSITY_ANALYTICS_DRYRUN === '1'
    || (mock && process.env.CURIOSITY_ANALYTICS_FORCE_NOTIFY !== '1');
  if (notifyBlocked) {
    log.info(mock && process.env.CURIOSITY_ANALYTICS_DRYRUN !== '1'
      ? 'RUN_MODE=mock — 합성 브리핑이므로 알림 발송 생략(강제: CURIOSITY_ANALYTICS_FORCE_NOTIFY=1)'
      : 'DRYRUN=1 — 알림 발송 생략');
  } else {
    process.env.NOTIFY_FORCE_LIVE = '1';
    try {
      delivery = await notify(EVENT_BRIEF, {
        reason: `호기심 쇼츠 일일 브리핑 (${today})`,
        details: briefing,
      });
      const sent = delivery.telegram === 'sent' || delivery.discord === 'sent';
      if (sent) log.info(`브리핑 발송됨 — telegram=${delivery.telegram} discord=${delivery.discord}`);
      else log.warn(`브리핑이 사람에게 도달하지 않았다(크리덴셜 확인) — ${JSON.stringify(delivery)}`);
    } catch (e) {
      log.error(`브리핑 발송 실패: ${e?.message || e}`);
    }
  }

  console.log(JSON.stringify({
    ok: true, path: docPath, videos: rows.length,
    subscribers: channel.subscribers ?? null, remaining: channel.remaining ?? null,
    mock: synthesized, delivery,
  }));
}

if (isMainModule(import.meta.url)) {
  main().catch(e => { log.error(`치명 오류: ${e.message}`); process.exit(1); });
}
