/**
 * apply-targeting.mjs (3-3b) — GSC 쿼리 데이터 → config/pipeline.json
 *   topic_targeting.niche_keywords 갱신 applier
 *
 * 화이트리스트: topic_targeting 키만 수정 가능. 다른 키는 백업과 byte 비교로 불변 검증.
 *
 * 실행 순서:
 *   ④ 콜드스타트 가드: 데이터 기간 < 14일 → held-not-applied 감사 이벤트 + exit 0
 *   ① 백업: state/config-backups/pipeline-<ISO ts>.json
 *   ② 신규 키워드 diff 생성 (추가/가중치 조정, 상한 25개)
 *   임시 적용 → config/pipeline.json 갱신
 *   ③ seed 무회귀 가드: benchmark/seed/*.md 전수 check-niche + check-dup
 *      FAIL이면 백업 복원 + exit 1
 *   ⑤ 다른 키 불변 검증 (topic_targeting 제외 JSON 문자열 비교)
 *   ⑤ 감사 로그 applied 이벤트 + diff 기록
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { makeLogger } from '../lib/log.mjs';
import { appendAudit } from '../audit/append.mjs';
import { loadSeoMetrics } from './gsc-collect.mjs';
import { loadDemandCandidates, markDemandConsumed, NICHE_SEED_TERMS } from './keyword-demand.mjs';

const log = makeLogger('seo-targeting');

const PIPELINE_CFG  = 'config/pipeline.json';
const BACKUP_DIR    = 'state/config-backups';
const SEED_DIR      = 'benchmark/seed';
const MAX_KEYWORDS  = 25;
const MIN_DATA_DAYS = 14;

// 니치 관련성 판정용 시드 텀 — 정본은 keyword-demand.mjs (2026-08-07 이동, 단일 출처).
// 의존 방향: apply-targeting → keyword-demand 단방향(역방향 import 금지 — 순환).

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────

function readPipeline() {
  return JSON.parse(readFileSync(PIPELINE_CFG, 'utf8'));
}

/** 데이터 기간: metrics Map에서 고유 날짜 수 */
function dataDayCount(metrics) {
  const dates = new Set();
  for (const key of metrics.keys()) {
    const [date] = key.split('|');
    dates.add(date);
  }
  return dates.size;
}

/** query 차원에서 니치 연관 키워드 추출 (기회 키워드 우선 정렬) */
function extractRisingKeywords(metrics) {
  const agg = new Map(); // query → {clicks, impressions, positions[]}

  for (const [, rec] of metrics) {
    if (rec.dimension !== 'query') continue;
    for (const row of (rec.rows || [])) {
      const q = (row.key || '').toLowerCase().trim();
      if (!q || q.length < 2) continue;
      if (!agg.has(q)) agg.set(q, { clicks: 0, impressions: 0, positions: [] });
      const e = agg.get(q);
      e.clicks      += (row.clicks      || 0);
      e.impressions += (row.impressions || 0);
      if (row.position != null) e.positions.push(row.position);
    }
  }

  const niched = [];
  for (const [q, d] of agg) {
    const isNiche = NICHE_SEED_TERMS.some(t => q.includes(t));
    if (!isNiche || d.impressions < 5) continue; // 노출 5 미만 잡음 제거
    const avg_position = d.positions.length
      ? d.positions.reduce((a, b) => a + b, 0) / d.positions.length
      : 99;
    const ctr = d.impressions > 0 ? d.clicks / d.impressions : 0;
    niched.push({ keyword: q, impressions: d.impressions, clicks: d.clicks, avg_position, ctr });
  }

  // 정렬: 순위 11~30 (기회) 우선, 그 다음 impression 내림차순
  niched.sort((a, b) => {
    const aOpp = (a.avg_position >= 11 && a.avg_position <= 30) ? 1 : 0;
    const bOpp = (b.avg_position >= 11 && b.avg_position <= 30) ? 1 : 0;
    if (bOpp !== aOpp) return bOpp - aOpp;
    return b.impressions - a.impressions;
  });

  return niched.slice(0, 20);
}

/**
 * 기존 키워드 + GSC 상승 신호 + 검색수요 후보(keyword-demand) → 새 키워드 목록.
 * export — 병합 규칙은 테스트(scripts/test/keyword-demand.test.mjs)가 고정한다.
 *
 * demand 는 keyword-demand-candidates.json 의 items: [{keyword, score}].
 * 신규만 추가하고(기존 가중치는 GSC 신호의 몫), 한 런에 maxNew 개까지만 —
 * 수요 데이터가 niche_keywords 를 한 번에 갈아엎지 못하게 하는 안전판이다.
 */
export function buildNewKeywords(existing, rising, demand = [], { maxNew = 5, tiers = [] } = {}) {
  const kmap = new Map();
  for (const kw of existing) kmap.set(kw.keyword.toLowerCase(), { ...kw });

  for (const r of rising) {
    const key = r.keyword;
    if (kmap.has(key)) {
      // 기존 키워드 중 순위 11~30 구간이면 가중치 +1 (최대 5)
      if (r.avg_position >= 11 && r.avg_position <= 30) {
        const curr = kmap.get(key);
        kmap.set(key, { ...curr, weight: Math.min(5, (curr.weight || 1) + 1) });
      }
    } else {
      // 신규 키워드: impression 100 이상이면 가중치 2, 아니면 1
      kmap.set(key, { keyword: key, weight: r.impressions >= 100 ? 2 : 1 });
    }
  }

  // 검색수요 후보 — 점수 구간(tiers)으로 가중치 결정, 신규만, maxNew 상한.
  // tiers 는 min_score 내림차순 가정이 아니라 여기서 정렬해 보장한다(설정 순서 실수 방어).
  const sortedTiers = [...tiers].sort((a, b) => b.min_score - a.min_score);
  let added = 0;
  for (const d of demand) {
    if (added >= maxNew) break;
    const key = String(d.keyword || '').toLowerCase();
    if (!key || kmap.has(key)) continue;
    const tier = sortedTiers.find(t => (d.score ?? 0) >= t.min_score);
    kmap.set(key, { keyword: key, weight: tier ? tier.weight : 1 });
    added++;
  }

  return [...kmap.values()]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_KEYWORDS);
}

/** topic_targeting 제외한 나머지 키 직렬화 비교 */
function otherKeysJson(cfg) {
  const copy = { ...cfg };
  delete copy.topic_targeting;
  return JSON.stringify(copy);
}

/** 단일 seed 파일에 게이트 실행. exit 0 = pass */
function runGate(gateName, seedFile) {
  try {
    execFileSync('node', [`scripts/gates/${gateName}.mjs`, seedFile], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** benchmark/seed/ 전수 check-niche + check-dup */
function verifySeedRegression() {
  if (!existsSync(SEED_DIR)) {
    log.warn(`${SEED_DIR} 없음 — seed 회귀가드 스킵`);
    return true;
  }

  let seeds;
  try { seeds = readdirSync(SEED_DIR).filter(f => f.endsWith('.md')); }
  catch (e) { log.warn(`seed 디렉토리 읽기 실패: ${e.message}`); return true; }

  if (seeds.length === 0) {
    log.warn('seed 파일 없음 — 회귀가드 스킵');
    return true;
  }

  log.info(`seed 회귀가드: ${seeds.length}편 × (check-niche + check-dup)`);
  let passed = 0;
  for (const f of seeds) {
    const path = `${SEED_DIR}/${f}`;
    const nicheOk = runGate('check-niche', path);
    const dupOk   = runGate('check-dup',   path);
    if (nicheOk && dupOk) {
      passed++;
    } else {
      log.error(`seed 회귀 감지: ${f} — niche=${nicheOk}, dup=${dupOk}`);
      return false;
    }
  }

  log.info(`seed 회귀가드 통과: ${passed}/${seeds.length}`);
  return true;
}

// ── 메인 ─────────────────────────────────────────────────────────────────────

async function main() {
  const metrics = loadSeoMetrics();

  // ④ 콜드스타트 가드
  const dayCount = dataDayCount(metrics);
  if (dayCount < MIN_DATA_DAYS) {
    log.info(`콜드스타트 가드: 데이터 ${dayCount}일 < ${MIN_DATA_DAYS}일 — 적용 보류`);
    try {
      appendAudit({
        actor:  'seo-targeting',
        action: 'seo-targeting-held',
        reason: `콜드스타트: 데이터 ${dayCount}일 (최소 ${MIN_DATA_DAYS}일 필요) — held-not-applied`,
      });
    } catch (e) { log.warn(`감사 기록 실패: ${e.message}`); }
    process.exit(0);
  }

  const pipeline  = readPipeline();
  const origOther = otherKeysJson(pipeline);
  const existing  = pipeline.topic_targeting?.niche_keywords || [];

  // ① 백업
  mkdirSync(BACKUP_DIR, { recursive: true });
  const ts         = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${BACKUP_DIR}/pipeline-${ts}.json`;
  writeFileSync(backupPath, JSON.stringify(pipeline, null, 2), 'utf8');
  log.info(`백업 생성: ${backupPath}`);

  // ② diff 생성 — GSC 상승 신호 + 주간 검색수요 후보(keyword-demand, 없으면/낡으면 빈 배열)
  const rising     = extractRisingKeywords(metrics);
  log.info(`상승 후보 키워드: ${rising.length}개`);

  let demandCfg = {};
  try { demandCfg = JSON.parse(readFileSync('config/keyword-demand.json', 'utf8')); } catch { /* 없으면 기본값 */ }
  const demandFile = loadDemandCandidates({ ttlDays: demandCfg.candidates_ttl_days ?? 21 });
  const demandItems = demandFile?.items ?? [];
  log.info(`검색수요 후보: ${demandItems.length}개${demandFile ? '' : ' (candidates 없음/만료 — 스킵)'}`);

  const newKeywords = buildNewKeywords(existing, rising, demandItems, {
    maxNew: demandCfg.apply?.max_new_per_run ?? 5,
    tiers:  demandCfg.apply?.weight_tiers ?? [],
  });
  log.info(`새 niche_keywords 후보: ${newKeywords.length}개`);

  const addedKeys   = newKeywords.filter(k => !existing.find(e => e.keyword === k.keyword)).map(k => k.keyword);
  const changedKeys = newKeywords.filter(k => {
    const e = existing.find(e => e.keyword === k.keyword);
    return e && e.weight !== k.weight;
  }).map(k => k.keyword);

  if (addedKeys.length === 0 && changedKeys.length === 0) {
    // demand 후보를 고려했지만 넣을 게 없었어도 소비 표시 — 내일 같은 파일을 재고려하지 않는다.
    if (demandItems.length > 0) markDemandConsumed();
    log.info('변경 없음 — 적용 스킵');
    process.exit(0);
  }

  const diff = { added: addedKeys, weight_changed: changedKeys, total: newKeywords.length };
  log.info('diff', diff);

  // ⑤-사전: 다른 키 불변 검증 (적용 전 구조로 검증)
  const modified = {
    ...pipeline,
    topic_targeting: {
      ...pipeline.topic_targeting,
      niche_keywords: newKeywords,
    },
  };
  if (otherKeysJson(modified) !== origOther) {
    log.error('topic_targeting 외 키 변경 감지 — 적용 거부 (버그)');
    process.exit(1);
  }

  // 임시 적용 (seed 회귀가드는 파일 적용 후 실행)
  writeFileSync(PIPELINE_CFG, JSON.stringify(modified, null, 2), 'utf8');

  // ③ seed 무회귀 가드
  const seedOk = verifySeedRegression();
  if (!seedOk) {
    log.error('seed 회귀가드 실패 — 백업 복원');
    const backup = readFileSync(backupPath, 'utf8');
    writeFileSync(PIPELINE_CFG, backup, 'utf8');
    process.exit(1);
  }

  // ⑤ 감사 로그
  try {
    appendAudit({
      actor:  'seo-targeting',
      action: 'seo-targeting-applied',
      reason: `topic_targeting.niche_keywords 갱신: 추가 ${addedKeys.length}개, 가중치변경 ${changedKeys.length}개, 총 ${newKeywords.length}개 — diff=${JSON.stringify(diff)}`,
    });
  } catch (e) { log.warn(`감사 기록 실패: ${e.message}`); }

  // 성공 적용 후에만 demand 소비 표시 — seed 회귀로 롤백된 경우는 표시하지 않아
  // 다음날 재시도된다(소비 표시가 곧 "니치 반영 완료" 선언이기 때문).
  if (demandItems.length > 0) markDemandConsumed();

  log.info(`적용 완료: ${PIPELINE_CFG} 갱신 (백업: ${backupPath})`);
}

// 단독 실행일 때만 main — buildNewKeywords export 를 테스트가 import 할 때
// 실제 적용(파일 쓰기·게이트 실행)이 따라 돌면 안 된다.
if (process.argv[1] && process.argv[1].endsWith('apply-targeting.mjs')) {
  main().catch(e => { log.error(`치명 오류: ${e.message}`); process.exit(1); });
}
