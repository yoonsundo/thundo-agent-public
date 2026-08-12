#!/usr/bin/env node
/**
 * cardnews/report.mjs — 카드뉴스 채널 성과 판정(머신 리더블)
 *
 * `--insights` 는 `state/cardnews/insights.jsonl`(append-only 성장곡선)을 접어 한 줄짜리
 * 판정으로 만든다. 여기서 **유일하게 의미 있는 숫자는 `save_rate = saved / reach`** 다 —
 * 저장 절대값은 도달이 늘면 같이 늘어서 "콘텐츠가 좋아졌는가"에 답하지 못한다.
 *
 * ⚠ 읽기 전용. 이 파일은 config 를 쓰지 않는다(자가발전은 v1.1 소관).
 */
import { existsSync, readFileSync } from 'node:fs';
import { insightsPath } from './insights.mjs';
import { kstDate, isMainModule } from './lib.mjs';

/**
 * jsonl 로드 — **깨진 줄은 무시**(loadRuns/loadBacklog 와 같은 정책). 한 줄이 상했다고
 * 몇 달치 성과 이력을 통째로 포기할 이유가 없다(인덱스와 달리 중복 발행 위험이 없다).
 */
export function loadInsights(path = insightsPath()) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function median(nums) {
  const a = nums.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

const round4 = n => (Number.isFinite(n) ? Math.round(n * 10000) / 10000 : null);

/**
 * 글별 **최신 성공 레코드**만 골라 접는다. 같은 글의 1일차·7일차 줄을 다 세면 오래된 글이
 * 표본을 지배해서 채널 상태가 아니라 수집 횟수를 재게 된다. 곡선 자체는 원본 jsonl 에 남아 있다.
 *
 * @returns {{posts:number, median_saved:number|null, median_reach:number|null,
 *            save_rate:number|null, top_post:Object|null, bottom_post:Object|null, days_covered:number}}
 */
export function insightsVerdict(records = loadInsights()) {
  const latest = new Map();
  for (const r of records) {
    if (!r || r.error_class) continue;                       // 실패 줄은 통계에서 제외
    if (!r.post_id) continue;
    const prev = latest.get(r.post_id);
    if (!prev || String(r.collected_at) > String(prev.collected_at)) latest.set(r.post_id, r);
  }
  const rows = [...latest.values()];

  // days_covered 는 "며칠치 관측이 쌓였나" — 실패 줄도 관측일이므로 전체 레코드에서 센다.
  const days = new Set();
  for (const r of records) {
    const t = Date.parse(r?.collected_at ?? '');
    if (Number.isFinite(t)) days.add(kstDate(new Date(t)));
  }

  const scored = rows
    .filter(r => Number.isFinite(Number(r.reach)) && Number(r.reach) > 0 && Number.isFinite(Number(r.saved)))
    .map(r => ({
      post_id: r.post_id,
      saved: Number(r.saved),
      reach: Number(r.reach),
      save_rate: round4(Number(r.saved) / Number(r.reach)),
      age_days: r.age_days ?? null,
    }))
    .sort((a, b) => b.save_rate - a.save_rate);

  const totalSaved = scored.reduce((s, r) => s + r.saved, 0);
  const totalReach = scored.reduce((s, r) => s + r.reach, 0);

  return {
    posts: rows.length,
    median_saved: median(rows.map(r => Number(r.saved))),
    median_reach: median(rows.map(r => Number(r.reach))),
    // 비율의 중앙값이 아니라 **가중 총계** — 도달 10짜리 글 하나가 채널 판정을 뒤집지 않는다.
    save_rate: totalReach > 0 ? round4(totalSaved / totalReach) : null,
    top_post: scored[0] ?? null,
    bottom_post: scored.length > 1 ? scored[scored.length - 1] : null,
    days_covered: days.size,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--insights')) {
    console.log(JSON.stringify(insightsVerdict(), null, 2));
    process.exit(0);
  }
  console.error('사용법: node scripts/cardnews/report.mjs --insights');
  process.exit(2);
}
