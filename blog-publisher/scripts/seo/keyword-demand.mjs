#!/usr/bin/env node
/**
 * keyword-demand.mjs — 검색 수요 키워드 폐루프 (주 1회, seo-weekly-cron.sh)
 *
 * 무엇을 고치나: 기존 SEO 폐루프는 GSC(=우리가 **이미 노출된** 쿼리)만 학습해서,
 * "사람들이 많이 검색하는데 우리 글이 아직 없는" 키워드는 영원히 niche_keywords 에
 * 들어올 수 없었다(콜드스타트 순환). 이 스크립트가 **수요 데이터**(네이버 데이터랩,
 * 공식 API)를 처음으로 파이프라인에 공급한다.
 *
 * 체인: 후보 수집(GSC 쿼리 + naver-seo 타겟쿼리 + niche_keywords + 발행글 태그)
 *   → 데이터랩 상대 수요 측정(앵커 정규화, datalab.mjs)
 *   → 기회 점수(구글 미노출/저순위 + 네이버 미노출 부스트)
 *   → state/keyword-demand.jsonl(이력) + state/keyword-demand-candidates.json(applier 입력)
 *   → docs/reports/seo/keyword-demand-<date>.md(사람용)
 *
 * 소비자: apply-targeting.mjs 가 candidates 를 읽어 기존 가드(백업·seed 무회귀·상한 25)
 * 그대로 niche_keywords 에 병합 → run-lion STEP 2 주제 가중치 → 발행 → GSC/naver-rank 측정.
 *
 * 계약(GSC/네이버 폐루프 동일): enabled=false·크리덴셜 없음 → warn+exit 0(비차단).
 * RUN_MODE=mock → 합성 데이터로 전 경로(파일 산출 포함). exit 0=정상 / 1=실패 / 2=실행오류.
 */
import { readFileSync, writeFileSync, appendFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeLogger } from '../lib/log.mjs';
import { loadSeoMetrics } from './gsc-collect.mjs';
import { loadNaverSeoConfig, loadCreds, isMockMode } from './naver-search.mjs';
import { fetchDemandScores } from './datalab.mjs';
import { fetchKeywordStats, loadSearchAdCreds, normKey } from './searchad.mjs';

import { isMainModule } from '../lib/main-module.mjs';
const log = makeLogger('keyword-demand');

const CFG_PATH        = 'config/keyword-demand.json';
const PIPELINE_CFG    = 'config/pipeline.json';
const NAVER_RANK_PATH = 'state/naver-rank.jsonl';
const HISTORY_PATH    = 'state/keyword-demand.jsonl';
const CANDIDATES_PATH = 'state/keyword-demand-candidates.json';
const REPORT_DIR      = 'docs/reports/seo';
const PUBLISHED_DIR   = 'published';

/**
 * 니치 판정 시드 텀 — **단일 정본**. apply-targeting.mjs 도 여기서 import 한다
 * (의존 방향: apply-targeting → keyword-demand, 역방향 없음 — 순환 금지).
 */
export const NICHE_SEED_TERMS = [
  'ai', 'claude', 'cursor', 'copilot', '코딩', 'coding', 'llm', 'gpt',
  '자동화', 'automation', 'vscode', 'windsurf', 'mcp', 'agent', 'vibe',
  'replit', 'devin', 'codeium', 'tabnine', '개발', 'dev', '프로그래밍',
  '퀀트', '자동매매', '트레이딩', '백테스팅', 'n8n', '에이전트', '프롬프트',
];

/** 짧은 라틴 텀은 부분문자열 매칭이 위험하다 — "gmail"⊃"ai", "device"⊃"dev" 오탐(2026-08-07 실측). */
const SHORT_LATIN_TERMS = new Set(['ai', 'dev', 'gpt', 'mcp']);

export function isNicheKeyword(kw) {
  const k = String(kw).toLowerCase();
  return NICHE_SEED_TERMS.some(t => {
    if (!SHORT_LATIN_TERMS.has(t)) return k.includes(t);
    // 한쪽 경계만 요구: 단어 한가운데 우연히 낀 것("gmail"의 ai — 양쪽 다 라틴)만 거부하고,
    // 합성어의 앞/끝 등장("openai"·"chatgpt"·"ai코딩")은 니치로 인정한다.
    return new RegExp(`(^|[^a-z])${t}|${t}([^a-z]|$)`).test(k);
  });
}

/**
 * apply-targeting 이 읽는 candidates 로더 — TTL 지난 파일은 없는 것으로 친다
 * (주간 잡이 죽었는데 낡은 수요로 계속 병합되는 것을 막는다).
 */
export function loadDemandCandidates({ path = CANDIDATES_PATH, ttlDays = 21, now = Date.now(), allowMock = isMockMode() } = {}) {
  if (!existsSync(path)) return null;
  let data;
  try { data = JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
  // 🔴 mock 런이 남긴 합성 수요를 실제 적용이 믿으면 안 된다 — mock 파일은 mock 에서만 유효.
  if (data.mock && !allowMock) return null;
  // 🔴 배치당 1회 소비 — 주간 candidates 를 일일 apply-targeting 이 7번 재소비하면
  //   "런당 신규 5개" 상한이 사실상 주당 20개(파일 크기)가 된다(아키텍트 리뷰 2026-08-07).
  if (data.consumed_at) return null;
  const age = now - Date.parse(data.generated_at || 0);
  if (!Number.isFinite(age) || age > ttlDays * 24 * 3600 * 1000) return null;
  return Array.isArray(data.items) ? data : null;
}

/**
 * candidates 소비 표시 — apply-targeting 이 demand 항목을 **고려 완료**한 직후 호출한다
 * (실제 추가 여부와 무관: 이미 다 들어있어 무변경이어도 재고려할 이유가 없다).
 * 실패는 던지지 않는다 — 표시 실패로 적용 자체를 죽이지 않는다(다음날 재소비가 최악이다).
 */
export function markDemandConsumed(path = CANDIDATES_PATH) {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    data.consumed_at = new Date().toISOString();
    writeFileSync(path, JSON.stringify(data, null, 2));
    return true;
  } catch { return false; }
}

// ── 후보 수집 (순수) ─────────────────────────────────────────────────────────

/** frontmatter 의 tags 를 관대하게 파싱 — inline 배열(["a","b"])과 대시 목록 둘 다. */
export function parseTags(md) {
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return [];
  const inline = fm[1].match(/^tags:\s*\[(.*)\]\s*$/m);
  if (inline) {
    return inline[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  const block = fm[1].match(/^tags:\s*\n((?:\s*-\s+.*\n?)+)/m);
  if (block) {
    return block[1].split('\n').map(l => l.replace(/^\s*-\s+/, '').trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  return [];
}

/**
 * 4개 소스 → 니치 필터 → dedup → 상한. 순수함수.
 * gscAgg: Map<query, {impressions, positions[]}> — 노출 1 이상이면 전부 후보(수요 측정이 거를 것).
 */
export function discoverCandidates({ gscQueries = [], naverQueries = [], nicheKeywords = [], postTags = [], max = 60 }) {
  const seen = new Map();     // kw → sources Set
  const spaceless = new Set(); // 띄어쓰기 변형 dedup — "ai자동화"/"ai 자동화" 가 둘 다 들어오는 것 방지
  const add = (kw, source) => {
    const k = String(kw || '').trim().toLowerCase();
    if (k.length < 2 || k.length > 40) return;
    if (!isNicheKeyword(k)) return;
    const flat = k.replace(/\s+/g, '');
    if (!seen.has(k) && spaceless.has(flat)) return; // 변형이 이미 있으면 우선순위 앞선 쪽만 유지
    if (!seen.has(k)) { seen.set(k, new Set()); spaceless.add(flat); }
    seen.get(k).add(source);
  };
  // 순서 = 우선순위(상한 잘림 시 앞이 산다): 이미 측정 중인 타겟 → 기존 가중치 → 실수요(GSC) → 태그
  for (const q of naverQueries)  add(q, 'naver-target');
  for (const k of nicheKeywords) add(k, 'niche-config');
  for (const q of gscQueries)    add(q, 'gsc');
  for (const t of postTags)      add(t, 'post-tag');
  return [...seen.entries()].slice(0, max).map(([keyword, sources]) => ({ keyword, sources: [...sources] }));
}

/**
 * 기회 점수 (순수) — "수요는 있는데 우리가 안 보이는" 정도.
 * 구글: 미노출 1.0 / 11위 밖 0.7 / 4~10위 0.3 / top3 0.
 * 네이버: 미노출 +0.5 / 노출 +0.
 */
export function scoreOpportunity({ googlePosition = null, naverBest = null }) {
  let g;
  if (googlePosition == null) g = 1.0;
  else if (googlePosition > 10) g = 0.7;
  else if (googlePosition > 3) g = 0.3;
  else g = 0;
  const n = naverBest == null ? 0.5 : 0;
  return Math.min(1.5, g + n);
}

/** 최종 점수 (순수). demand null(측정 불능)은 null — 후보에서 제외하되 이력에는 남긴다. */
export function finalScore(demand, opportunity) {
  if (demand == null) return null;
  return demand * (0.5 + opportunity);
}

// ── 로컬 신호 로더 ───────────────────────────────────────────────────────────

/** GSC query 차원 집계: query → {impressions, avgPosition} */
function loadGscQueryAgg(metrics) {
  const agg = new Map();
  for (const [, rec] of metrics) {
    if (rec.dimension !== 'query') continue;
    for (const row of (rec.rows || [])) {
      const q = (row.key || '').toLowerCase().trim();
      if (!q) continue;
      if (!agg.has(q)) agg.set(q, { impressions: 0, positions: [] });
      const e = agg.get(q);
      e.impressions += row.impressions || 0;
      if (row.position != null) e.positions.push(row.position);
    }
  }
  const out = new Map();
  for (const [q, d] of agg) {
    out.set(q, {
      impressions: d.impressions,
      avgPosition: d.positions.length ? d.positions.reduce((a, b) => a + b, 0) / d.positions.length : null,
    });
  }
  return out;
}

/** naver-rank.jsonl → query(소문자) → 최신 best 순위(null=미노출). */
function loadNaverBest() {
  if (!existsSync(NAVER_RANK_PATH)) return new Map();
  const latest = new Map(); // q → {date, best}
  for (const line of readFileSync(NAVER_RANK_PATH, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    const q = String(rec.query || '').toLowerCase();
    if (!q) continue;
    const prev = latest.get(q);
    if (!prev || String(rec.date) > String(prev.date)) latest.set(q, { date: rec.date, best: rec.best ?? null });
  }
  return new Map([...latest.entries()].map(([q, v]) => [q, v.best]));
}

/** published/*.md 태그 전수 (실패는 건너뜀 — 태그는 보조 소스다). */
function loadPostTags() {
  if (!existsSync(PUBLISHED_DIR)) return [];
  const tags = [];
  for (const f of readdirSync(PUBLISHED_DIR)) {
    if (!f.endsWith('.md')) continue;
    try { tags.push(...parseTags(readFileSync(join(PUBLISHED_DIR, f), 'utf8'))); }
    catch { /* 개별 파일 실패 무시 */ }
  }
  return tags;
}

// ── 리포트 ───────────────────────────────────────────────────────────────────

function fmtPos(v) { return v == null ? '미노출' : v.toFixed(1); }

/** 외부 유래 문자열(GSC 쿼리 등)을 마크다운 표 셀에 안전하게 — 파이프·개행이 표를 깬다. */
function mdCell(s) { return String(s).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' '); }

export function buildReport({ date, anchor, rows, calls, failures, measured }) {
  const L = [];
  L.push(`# 검색 수요 키워드 리포트 — ${date}`);
  L.push('');
  const hasMonthly = rows.some(r => r.monthly != null);
  L.push(`앵커: \`${anchor}\` (수요 점수 = ${hasMonthly ? '월간검색수' : '데이터랩 상대검색량'} ÷ 앵커, 즉 1.0 = 앵커와 같은 수요)`);
  L.push(`측정: 후보 ${measured}개 · ${hasMonthly ? '검색광고 키워드도구' : '데이터랩'} ${calls}콜 · 실패 배치 ${failures}`);
  L.push('');
  L.push(`| # | 키워드 |${hasMonthly ? ' 월간검색수 |' : ''} 수요(×앵커) | 기회 | 점수 | 구글 평균순위 | 네이버 최고순위 | 출처 |`);
  L.push(`|---|--------|${hasMonthly ? '-----------|' : ''}------------|------|------|--------------|----------------|------|`);
  rows.forEach((r, i) => {
    const monthlyCell = hasMonthly ? ` ${r.monthly == null ? '—' : r.monthly.toLocaleString()} |` : '';
    L.push(`| ${i + 1} | ${mdCell(r.keyword)} |${monthlyCell} ${r.demand == null ? '측정불능' : r.demand.toFixed(2)} | ${r.opportunity.toFixed(1)} | ${r.score == null ? '—' : r.score.toFixed(2)} | ${fmtPos(r.google.avg_position)} | ${r.naver_best == null ? '미노출' : r.naver_best} | ${r.sources.join(',')} |`);
  });
  L.push('');
  L.push('- **수요↑ + 미노출** 조합이 곧 기사 기회다. 상위 후보는 apply-targeting 이 niche_keywords 로 병합해 다음 글 주제 선정에 가중된다.');
  L.push(`- 자동 생성: \`scripts/seo/keyword-demand.mjs\``);
  return L.join('\n');
}

// ── 메인 ─────────────────────────────────────────────────────────────────────

async function main() {
  const cfg = JSON.parse(readFileSync(CFG_PATH, 'utf8'));
  if (!cfg.enabled) { log.info('enabled=false — 스킵'); return 0; }

  const pipeline = JSON.parse(readFileSync(PIPELINE_CFG, 'utf8'));
  const naverCfg = loadNaverSeoConfig();
  const metrics  = loadSeoMetrics();
  const gscAgg   = loadGscQueryAgg(metrics);

  const candidates = discoverCandidates({
    gscQueries:    [...gscAgg.keys()],
    naverQueries:  naverCfg.target_queries || [],
    nicheKeywords: (pipeline.topic_targeting?.niche_keywords || []).map(k => k.keyword),
    postTags:      loadPostTags(),
    max:           cfg.max_candidates ?? 60,
  });
  log.info(`후보 ${candidates.length}개 (gsc쿼리 ${gscAgg.size} · 네이버타겟 ${(naverCfg.target_queries || []).length})`);
  if (candidates.length === 0) { log.warn('후보 0개 — 종료'); return 0; }

  // ── 수요 소스 선택: 검색광고(절대 월간검색량, 우선) → 데이터랩(상대, 폴백) ──
  // 개발자센터 데이터랩은 2026-07-31 부터 신규등록 차단이라(실측 401) 검색광고가 주 소스다.
  const saCreds = cfg.searchad?.enabled ? loadSearchAdCreds() : null;
  const useSearchAd = !!saCreds || (cfg.searchad?.enabled && isMockMode());

  let demand;            // { scores: Map<kw, number|null>, calls, failures }
  let monthly = null;    // 검색광고일 때만: Map<kw, 월간검색수>
  let source;

  if (useSearchAd) {
    source = 'searchad';
    const anchor = cfg.anchor_keyword;
    const sa = await fetchKeywordStats([anchor, ...candidates.map(c => c.keyword)], { creds: saCreds });
    if (sa.stats.size === 0 && sa.failures > 0) {
      // 🔴 크리덴셜이 있는데 전 배치 실패 = 운영 장애. exit 0 으로 삼키면 주간 크론이
      //   매주 "성공"으로 보고하는 거짓 green 이 된다(2026-07-23 교훈 — 아키텍트 리뷰).
      //   rc 1 → seo-weekly-cron 의 worst → cron-step-fail 알림.
      log.error(`검색광고 키워드도구 전 배치 실패(${sa.failures}) — 라이선스 상태/서명 확인 필요`);
      return 1;
    }
    // 연관키워드 확장 — 후보에 없던 니치 키워드를 수요와 함께 얻는다(추가 콜 0회).
    const relCap = cfg.searchad?.related_cap ?? 15;
    const known = new Set(candidates.map(c => normKey(c.keyword)));
    let addedRel = 0;
    for (const rel of sa.related) {
      if (addedRel >= relCap) break;
      if (!isNicheKeyword(rel.keyword) || known.has(normKey(rel.keyword))) continue;
      candidates.push({ keyword: rel.keyword.toLowerCase(), sources: ['searchad-rel'] });
      known.add(normKey(rel.keyword));
      addedRel++;
    }
    if (addedRel) log.info(`연관키워드 확장: +${addedRel}개 (검색광고 응답 재활용, 추가 콜 없음)`);

    // 점수 축 통일: demand = 월간검색수 ÷ 앵커 월간검색수 (데이터랩과 같은 의미의 배율)
    const anchorTotal = sa.stats.get(normKey(anchor))?.total ?? 0;
    if (anchorTotal <= 0) log.warn(`앵커 "${anchor}" 월간검색수 0 — demand 배율 산출 불가(null 처리)`);
    monthly = new Map();
    const scores = new Map();
    for (const { keyword } of candidates) {
      const st = sa.stats.get(normKey(keyword));
      const total = st ? st.total : 0;
      monthly.set(keyword, total);
      scores.set(keyword, anchorTotal > 0 ? total / anchorTotal : null);
    }
    demand = { scores, calls: sa.calls, failures: sa.failures };
    log.info(`검색광고 측정: ${sa.stats.size}개 실측, 앵커 월간검색수 ${anchorTotal}`);
  } else {
    source = 'datalab';
    const creds = loadCreds(naverCfg);
    if (!creds && !isMockMode()) {
      log.warn('수요 소스 크리덴셜 없음(검색광고·데이터랩 모두) — 비차단 종료');
      return 0;
    }
    demand = await fetchDemandScores(candidates.map(c => c.keyword), {
      anchor:       cfg.anchor_keyword,
      lookbackDays: cfg.lookback_days ?? 90,
      timeUnit:     cfg.time_unit ?? 'week',
      creds,
    });
    if (!demand) { log.warn('데이터랩 응답 없음 — 종료'); return 0; }
    if (demand.scores.size === 0 && demand.failures > 0) {
      log.error(`데이터랩 전 배치 실패(${demand.failures}) — 개발자센터 앱에 "데이터랩(검색어트렌드)" API 등록 여부를 확인하라`);
      return 1;
    }
  }

  const naverBest = loadNaverBest();
  const rows = candidates.map(({ keyword, sources }) => {
    const g = gscAgg.get(keyword) || { impressions: 0, avgPosition: null };
    const d = demand.scores.has(keyword) ? demand.scores.get(keyword) : null;
    const opportunity = scoreOpportunity({ googlePosition: g.avgPosition, naverBest: naverBest.get(keyword) ?? null });
    return {
      keyword, sources,
      demand: d,
      monthly: monthly ? (monthly.get(keyword) ?? null) : null,   // 검색광고일 때만: 절대 월간검색수
      opportunity,
      score: finalScore(d, opportunity),
      google: { impressions: g.impressions, avg_position: g.avgPosition },
      naver_best: naverBest.get(keyword) ?? null,
    };
  }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

  const date = new Date().toISOString().slice(0, 10);

  // ① 이력 (append) — 추세 분석·자가발전 입력용
  const mock = isMockMode();
  appendFileSync(HISTORY_PATH, JSON.stringify({
    date, anchor: cfg.anchor_keyword, source, measured: rows.length,
    calls: demand.calls, failures: demand.failures, ...(mock ? { mock: true } : {}),
    top: rows.slice(0, 10).map(r => ({ keyword: r.keyword, demand: r.demand, monthly: r.monthly, score: r.score })),
  }) + '\n');

  // ② applier 입력 — 수요 있는 것만. mock 표시는 loadDemandCandidates 가 실적용에서 거른다.
  const items = rows.filter(r => r.score != null && r.demand >= (cfg.min_demand_score ?? 0.05)).slice(0, 20);
  writeFileSync(CANDIDATES_PATH, JSON.stringify({
    generated_at: new Date().toISOString(), anchor: cfg.anchor_keyword, source, ...(mock ? { mock: true } : {}), items,
  }, null, 2));

  // ③ 사람용 리포트
  mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = join(REPORT_DIR, `keyword-demand-${date}.md`);
  writeFileSync(reportPath, buildReport({
    date, anchor: cfg.anchor_keyword,
    rows: rows.slice(0, cfg.max_report_rows ?? 30),
    calls: demand.calls, failures: demand.failures, measured: rows.length,
  }));

  log.info(`완료 — 후보 ${items.length}개 적재(${CANDIDATES_PATH}), 리포트 ${reportPath}`);
  console.log(JSON.stringify({ ok: true, measured: rows.length, candidates: items.length, report: reportPath }));
  return 0;
}

// 단독 실행일 때만 main (테스트는 import 만)
if (isMainModule(import.meta.url)) {
  main().then(c => process.exit(c)).catch(e => { log.error(`실행오류: ${e.message}`); process.exit(2); });
}
