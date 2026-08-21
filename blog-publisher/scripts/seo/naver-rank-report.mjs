/**
 * naver-rank-report.mjs — 네이버 검색 순위 추세 리포트 + 브리핑
 *
 * state/naver-rank.jsonl 을 읽어 최신일 vs 전일 순위를 비교:
 *   신규진입 / 이탈 / 순위상승 / 순위하락 / 미노출 집계.
 * → docs/reports/seo/naver-rank-YYYY-MM-DD.md 아카이브
 * → Slack(CRW 웹훅)·Discord·Telegram 브리핑 (insight-brief 채널 라우팅 준수).
 *
 * NAVER_RANK_DRYRUN=1 → 전송 생략(리포트 md 는 항상 생성). 검증·mock 안전.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeLogger } from '../lib/log.mjs';
import { sendReport } from '../notify/send-report.mjs';
import { sendSlackWebhook } from '../notify/slack-webhook.mjs';
import { loadNaverSeoConfig } from './naver-search.mjs';
import { loadNaverRanks } from './naver-rank-collect.mjs';

import { isMainModule } from '../lib/main-module.mjs';
const log = makeLogger('naver-rank-report');

const REPORT_DIR = process.env.NAVER_REPORT_DIR || 'docs/reports/seo';

/** 순위 비교 요약 계산. */
export function buildSummary(rankMap) {
  const byDate = new Map(); // date → Map(query → rec)
  for (const rec of rankMap.values()) {
    if (!byDate.has(rec.date)) byDate.set(rec.date, new Map());
    byDate.get(rec.date).set(rec.query, rec);
  }
  const dates = [...byDate.keys()].sort();
  const today = dates[dates.length - 1] || null;
  const prev = dates.length >= 2 ? dates[dates.length - 2] : null;
  const todayMap = today ? byDate.get(today) : new Map();
  const prevMap = prev ? byDate.get(prev) : new Map();

  const bestRank = (rec) => (rec && rec.best && rec.best.rank != null) ? rec.best.rank : null;

  const rows = [];
  for (const [query, rec] of todayMap) {
    const t = bestRank(rec);
    const p = bestRank(prevMap.get(query));
    let status, delta = null;
    if (t != null && p == null) status = prev ? 'new' : 'ranked';
    else if (t == null && p != null) status = 'dropped';
    else if (t == null && p == null) status = 'absent';
    else { delta = p - t; status = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'; }
    rows.push({ query, today: t, prev: p, delta, status, url: rec.best?.url || null });
  }
  rows.sort((a, b) => (a.today ?? 999) - (b.today ?? 999));

  const count = (s) => rows.filter(r => r.status === s).length;
  const summary = {
    today, prev,
    total: rows.length,
    ranked: rows.filter(r => r.today != null).length,
    counts: {
      new: count('new'), up: count('up'), down: count('down'),
      dropped: count('dropped'), flat: count('flat'), absent: count('absent'),
    },
    rows,
  };
  // 상태: 상승/신규 우세=green, 하락/이탈 우세=red, 그 외 yellow
  const good = summary.counts.new + summary.counts.up;
  const bad = summary.counts.down + summary.counts.dropped;
  summary.status = !prev ? 'yellow' : good > bad ? 'green' : bad > good ? 'red' : 'yellow';
  summary.headline = prev
    ? `네이버 순위: 신규 ${summary.counts.new} · 상승 ${summary.counts.up} · 하락 ${summary.counts.down} · 이탈 ${summary.counts.dropped} (노출 ${summary.ranked}/${summary.total})`
    : `네이버 순위 첫 수집: 노출 ${summary.ranked}/${summary.total}쿼리 (전일 비교는 다음 런부터)`;
  return summary;
}

const ARROW = { new: '🆕', up: '🔼', down: '🔽', dropped: '❌', flat: '➖', absent: '·', ranked: '✅' };

function deltaText(r) {
  if (r.status === 'new' || r.status === 'ranked') return `신규 ${r.today}위`;
  if (r.status === 'dropped') return `이탈 (전일 ${r.prev}위)`;
  if (r.status === 'absent') return '미노출';
  if (r.status === 'flat') return `${r.today}위 (변동없음)`;
  return `${r.today}위 (${r.delta > 0 ? '+' : ''}${r.delta})`;
}

function renderArchiveMd(s) {
  const lines = [
    `# 네이버 검색 순위 리포트 — ${s.today || '(데이터 없음)'}`,
    '',
    `> 자동 생성: \`scripts/seo/naver-rank-report.mjs\` · 공식 검색 API 기반`,
    `> ${s.headline}`,
    '',
    `## 요약 (status: ${s.status})`,
    '',
    `- 타겟 쿼리: ${s.total} · 노출: ${s.ranked} · 미노출: ${s.counts.absent + s.counts.dropped} (그중 이탈 ${s.counts.dropped})`,
    `- ⓘ 순위는 검색 API display 상한(config) 밖이면 미노출로 집계됩니다.`,
    `- 🆕 신규 ${s.counts.new} · 🔼 상승 ${s.counts.up} · 🔽 하락 ${s.counts.down} · ❌ 이탈 ${s.counts.dropped} · ➖ 유지 ${s.counts.flat}`,
    s.prev ? `- 비교: ${s.prev} → ${s.today}` : '- 전일 비교 없음(첫 수집)',
    '',
    '## 쿼리별',
    '',
    '| 쿼리 | 상태 | 오늘 | 전일 | 변화 |',
    '|------|------|------|------|------|',
  ];
  for (const r of s.rows) {
    lines.push(`| ${r.query} | ${ARROW[r.status] || ''} | ${r.today ?? '-'} | ${r.prev ?? '-'} | ${deltaText(r)} |`);
  }
  lines.push('');
  return lines.join('\n');
}

const STATUS_EMOJI = { green: '🟢', red: '🔴', yellow: '🟡' };

function renderSlack(s) {
  const top = s.rows.filter(r => r.today != null).slice(0, 10)
    .map(r => `${ARROW[r.status]} *${r.query}* — ${deltaText(r)}`).join('\n') || '_노출된 쿼리 없음_';
  return {
    text: `네이버 순위 ${s.today || ''}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `${STATUS_EMOJI[s.status] || '🟡'} 네이버 검색 순위 — ${s.today || '데이터 없음'}` } },
      { type: 'section', text: { type: 'mrkdwn', text: s.headline } },
      { type: 'section', text: { type: 'mrkdwn', text: top } },
    ],
  };
}

function renderDiscord(s) {
  const color = s.status === 'green' ? 0x2ecc71 : s.status === 'red' ? 0xe74c3c : 0xf1c40f;
  const desc = s.rows.filter(r => r.today != null).slice(0, 10)
    .map(r => `${ARROW[r.status]} **${r.query}** — ${deltaText(r)}`).join('\n') || '노출된 쿼리 없음';
  return { embeds: [{ title: `네이버 검색 순위 — ${s.today || '데이터 없음'}`, description: `${s.headline}\n\n${desc}`, color }] };
}

function renderTelegram(s) {
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const top = s.rows.filter(r => r.today != null).slice(0, 10)
    .map(r => `${ARROW[r.status]} <b>${esc(r.query)}</b> — ${esc(deltaText(r))}`).join('\n') || '노출된 쿼리 없음';
  return [`<b>네이버 검색 순위 — ${esc(s.today || '데이터 없음')}</b>\n${esc(s.headline)}\n\n${top}`];
}

async function main() {
  const cfg = loadNaverSeoConfig();
  if (cfg.enabled === false) { log.info('config.enabled=false — 리포트 스킵'); process.exit(0); }

  const rankMap = loadNaverRanks();
  if (rankMap.size === 0) {
    log.info('수집 데이터 없음 (state/naver-rank.jsonl 비었거나 없음) — 리포트 스킵 (크리덴셜 설정 후 수집되면 생성)');
    process.exit(0);
  }
  const summary = buildSummary(rankMap);

  mkdirSync(REPORT_DIR, { recursive: true });
  const docPath = join(REPORT_DIR, `naver-rank-${summary.today || 'empty'}.md`);
  writeFileSync(docPath, renderArchiveMd(summary), 'utf8');
  log.info(`아카이브 저장: ${docPath} · status=${summary.status} · ${summary.headline}`);

  if (process.env.NAVER_RANK_DRYRUN) {
    log.info('DRYRUN — 전송 생략');
  } else if (summary.total === 0) {
    log.info('데이터 없음 — 전송 생략');
  } else {
    const slack = renderSlack(summary), discord = renderDiscord(summary), telegram = renderTelegram(summary);
    // Slack 은 블로그 채널(CRW 웹훅) — insight/lion-brief 선례. sendReport 의 slack 레그는 SALES 채널이라 null.
    const [slackRes, rest] = await Promise.all([
      sendSlackWebhook(slack),
      sendReport({ slack: null, discord, telegram }),
    ]);
    log.info(`전송 결과: ${JSON.stringify([slackRes, ...rest.filter(r => r.channel !== 'slack')])}`);
  }
  log.info('완료.');
}

if (isMainModule(import.meta.url)) {
  main().catch(e => { log.error(`치명 오류: ${e.message}`); process.exit(1); });
}
