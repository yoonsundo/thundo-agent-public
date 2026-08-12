/**
 * naver-rank-collect.mjs — 네이버 검색 순위 일일 수집
 *
 * 타겟 쿼리(config.target_queries + GSC 상위쿼리 시드)마다 네이버 검색 API(webkr+blog)를
 * 호출해 우리 도메인이 몇 위에 노출되는지 추출 → state/naver-rank.jsonl 에 (date,query) upsert.
 *
 * 계약(GSC gsc-collect 동일):
 *   - config.enabled=false → 스킵 exit 0
 *   - 크리덴셜 없음 + 非mock → warn + exit 0 (cron 에러 아님)
 *   - RUN_MODE=mock → 합성 데이터로 정상 수집(검증용)
 *
 * ⚠ 공식 검색 API만. 스크래핑·탐지회피 금지.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { makeLogger } from '../lib/log.mjs';
import {
  loadNaverSeoConfig, loadCreds, isMockMode, searchNaver, findRank, resolveApi,
} from './naver-search.mjs';
import { loadSeoMetrics } from './gsc-collect.mjs';

const log = makeLogger('naver-rank-collect');

const RANK_PATH = process.env.NAVER_RANK_PATH || 'state/naver-rank.jsonl';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** state/naver-rank.jsonl 을 (date,query) 키 Map 으로 로드. 같은 키는 마지막 줄이 유효(upsert). */
export function loadNaverRanks(path = RANK_PATH) {
  if (!existsSync(path)) return new Map();
  const map = new Map();
  for (const line of readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)) {
    try {
      const rec = JSON.parse(line);
      if (rec.date && rec.query) map.set(`${rec.date}|${rec.query}`, rec);
    } catch { /* 손상 줄 스킵 */ }
  }
  return map;
}

function upsertRanks(records) {
  const existing = loadNaverRanks();
  for (const rec of records) existing.set(`${rec.date}|${rec.query}`, rec);
  mkdirSync('state', { recursive: true });
  writeFileSync(RANK_PATH, [...existing.values()].map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

/** GSC query 차원에서 노출 상위 N 쿼리를 시드로 추출. */
function gscTopQueries(topN) {
  const metrics = loadSeoMetrics();
  const agg = new Map();
  for (const rec of metrics.values()) {
    if (rec.dimension !== 'query') continue;
    for (const row of rec.rows || []) {
      agg.set(row.key, (agg.get(row.key) || 0) + (row.impressions || 0));
    }
  }
  return [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([k]) => k);
}

/** 최종 타겟 쿼리 목록: config + GSC 시드 dedup, daily_cap 제한. */
export function resolveTargetQueries(cfg) {
  const set = new Set((cfg.target_queries || []).map(q => q.trim()).filter(Boolean));
  if (cfg.seed_from_gsc) {
    for (const q of gscTopQueries(cfg.gsc_top_n || 15)) {
      const t = q.trim();
      if (t) set.add(t);
    }
  }
  return [...set].slice(0, cfg.daily_cap || 40);
}

function isoDate(d = new Date()) { return d.toISOString().slice(0, 10); }

async function main() {
  const cfg = loadNaverSeoConfig();
  if (cfg.enabled === false) {
    log.info('config.enabled=false — 네이버 순위수집 스킵');
    process.exit(0);
  }

  const api = resolveApi(cfg);
  const creds = loadCreds(cfg);
  const mock = isMockMode();
  if (!creds && !mock) {
    log.warn(`네이버 크리덴셜 없음 (${api.id_env}/${api.secret_env} 미설정, provider=${api.provider}) — 수집 스킵`);
    process.exit(0);
  }

  const aliases = cfg.domain_aliases || [cfg.our_domain];
  const types = cfg.search_types || ['webkr', 'blog'];
  const queries = resolveTargetQueries(cfg);
  const date = isoDate();

  if (queries.length === 0) {
    log.warn('타겟 쿼리 0개 (config.target_queries 비었고 GSC 시드도 없음) — 수집 스킵');
    process.exit(0);
  }

  log.info(`수집 시작: ${queries.length}쿼리 × ${types.length}타입 (mock=${mock || !creds}, provider=${api.provider})`);

  const records = [];
  for (const query of queries) {
    const ranks = [];
    for (const type of types) {
      try {
        const { items } = await searchNaver(type, query, { cfg, creds });
        const rank = findRank(items, aliases);
        const url = rank ? items[rank - 1].link : null;
        ranks.push({ type, rank, url, pool: items.length });
      } catch (e) {
        log.warn(`검색 실패 (${type}/${query}): ${e.message}`);
        ranks.push({ type, rank: null, url: null, pool: 0, error: String(e.message) });
      }
      if (!mock && creds && cfg.request_delay_ms) await sleep(cfg.request_delay_ms);
    }
    // best = 순위가 있는 것 중 최상위(숫자 작은 것)
    const ranked = ranks.filter(r => r.rank != null).sort((a, b) => a.rank - b.rank);
    const best = ranked[0] || null;
    records.push({ date, query, collected_at: new Date().toISOString(), ranks, best });
  }

  upsertRanks(records);
  const found = records.filter(r => r.best).length;
  log.info(`state/naver-rank.jsonl upsert 완료: ${records.length}쿼리 (노출확인 ${found}, 미노출 ${records.length - found})`);
}

if (process.argv[1] && process.argv[1].endsWith('naver-rank-collect.mjs')) {
  main().catch(e => { log.error(`치명 오류: ${e.message}`); process.exit(1); });
}
