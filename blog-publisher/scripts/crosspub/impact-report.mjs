#!/usr/bin/env node
/**
 * crosspub/impact-report.mjs — 원본 무손상 모니터링 가드 (차단 아님, 관찰 전용)
 *
 * 교차발행(posted)된 글별로 게시 전/후 윈도우(기본 7일)의 원본 GSC 지표를 비교해
 * 원본(thundo.kr) 순위·클릭 잠식 여부를 표로 보여준다. 딥인터뷰 스펙의
 * "(모니터링 가드) 주간 코호트 리포트에서 관찰" 항목의 실측 도구.
 *
 * 사용: node scripts/crosspub/impact-report.mjs [--window 7]
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCrosspubConfig, loadIndex, seoMetricsPath, urlToSlug } from './lib.mjs';

/** seo-metrics.jsonl → slug별 {date → {clicks, impressions, position}} */
export function dailySeries(jsonlRaw, siteBaseUrl) {
  const bySlug = new Map();
  for (const line of jsonlRaw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.dimension !== 'page' || !Array.isArray(rec.rows) || !rec.date) continue;
    for (const row of rec.rows) {
      const slug = urlToSlug(row.key, siteBaseUrl);
      if (!slug) continue;
      if (!bySlug.has(slug)) bySlug.set(slug, new Map());
      const days = bySlug.get(slug);
      const cur = days.get(rec.date) || { clicks: 0, impressions: 0, position: null };
      cur.clicks += row.clicks || 0;
      cur.impressions += row.impressions || 0;
      cur.position = row.position ?? cur.position;
      days.set(rec.date, cur);
    }
  }
  return bySlug;
}

/** 게시일 기준 전/후 윈도우 합산 비교 (순수 함수) */
export function compareWindows(days, postedDate, windowDays) {
  const sum = (from, to) => { // [from, to) — YYYY-MM-DD 문자열 비교
    let clicks = 0, impressions = 0, posN = 0, posSum = 0;
    for (const [d, v] of days) {
      if (d >= from && d < to) {
        clicks += v.clicks; impressions += v.impressions;
        if (v.position != null) { posSum += v.position; posN++; }
      }
    }
    return { clicks, impressions, position: posN ? posSum / posN : null };
  };
  const shift = (dateStr, n) => new Date(new Date(dateStr + 'T00:00:00Z').getTime() + n * 86400_000).toISOString().slice(0, 10);
  const pre = sum(shift(postedDate, -windowDays), postedDate);
  const post = sum(postedDate, shift(postedDate, windowDays));
  const declined = post.clicks < pre.clicks * 0.7 && pre.clicks >= 5; // 노이즈 필터: 표본 적으면 판단 유보
  return { pre, post, declined };
}

function fmtPos(p) { return p == null ? '—' : p.toFixed(1); }

function main() {
  const cfg = loadCrosspubConfig();
  const args = process.argv.slice(2);
  const wi = args.indexOf('--window');
  const windowDays = wi >= 0 ? parseInt(args[wi + 1], 10) || 7 : 7;

  const idx = loadIndex();
  const posted = [];
  for (const [slug, entry] of Object.entries(idx)) {
    for (const [platform, st] of Object.entries(entry.platforms || {})) {
      if (st.status === 'posted' && st.posted_at) posted.push({ slug, platform, posted_at: st.posted_at.slice(0, 10), url: st.url });
    }
  }

  process.stdout.write(`\n교차발행 원본 무손상 리포트 — 전/후 ${windowDays}일 윈도우 (모니터링 가드, 차단 아님)\n`);
  process.stdout.write('═'.repeat(90) + '\n');

  if (posted.length === 0) {
    process.stdout.write('(posted 전이된 교차발행 없음 — queue-status --mark-posted 후 데이터가 쌓입니다)\n');
  } else if (!existsSync(seoMetricsPath())) {
    process.stdout.write('(seo-metrics.jsonl 없음 — GSC 수집 후 재실행)\n');
  } else {
    const series = dailySeries(readFileSync(seoMetricsPath(), 'utf8'), cfg.site_base_url);
    process.stdout.write(`${'slug'.padEnd(40)} ${'플랫폼'.padEnd(8)} ${'전 클릭'.padEnd(7)} ${'후 클릭'.padEnd(7)} ${'전 순위'.padEnd(7)} ${'후 순위'.padEnd(7)} 판정\n`);
    process.stdout.write('─'.repeat(90) + '\n');
    for (const p of posted) {
      const days = series.get(p.slug);
      if (!days) {
        process.stdout.write(`${p.slug.slice(0, 40).padEnd(40)} ${p.platform.padEnd(8)} (GSC 데이터 없음)\n`);
        continue;
      }
      const { pre, post, declined } = compareWindows(days, p.posted_at, windowDays);
      const verdict = declined ? '⚠ 원본 하락 관찰 — 잠식 의심, 역링크·기간 확인' : 'OK';
      process.stdout.write(`${p.slug.slice(0, 40).padEnd(40)} ${p.platform.padEnd(8)} ${String(pre.clicks).padEnd(7)} ${String(post.clicks).padEnd(7)} ${fmtPos(pre.position).padEnd(7)} ${fmtPos(post.position).padEnd(7)} ${verdict}\n`);
    }
  }

  const t = cfg.success_targets || {};
  process.stdout.write('─'.repeat(90) + '\n');
  process.stdout.write(`성공 지표 타겟(${t.horizon_days ?? 90}일): 플랫폼 합산 팔로워 ${t.followers_total ?? '?'}+ · 외부발 referral 주 ${t.referral_clicks_weekly ?? '?'}클릭+\n`);
  process.stdout.write('  (팔로워·referral 은 플랫폼 통계/애널리틱스에서 수동 확인 — GSC 는 검색 유입만 본다)\n\n');
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) {
  main();
}
