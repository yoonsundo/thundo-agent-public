/**
 * gsc-collect.mjs — GSC Search Analytics 일일 수집
 *
 * 인증: 서비스 계정 JSON 키 → google-auth-library JWT → Bearer token → fetch 직접 호출
 * 스코프: webmasters.readonly
 * 두 쿼리: dimensions ['date','page'] 와 ['date','query']
 *
 * upsert 규칙:
 *   state/seo-metrics.jsonl 은 (date, dimension) 복합 키 기준 upsert.
 *   같은 키가 여러 줄 존재할 경우 파일의 마지막 레코드를 유효로 취급.
 *   재수집 시 기존 레코드를 교체(전체 파일 재기록)하여 항상 최신값이 남는다.
 *   loadSeoMetrics() 헬퍼가 이 규칙으로 Map을 구성해 반환하므로, 다른 스크립트는
 *   이 헬퍼를 통해 읽으면 upsert 의미론을 자동으로 만족한다.
 *
 * env:
 *   GSC_SA_KEY_PATH   — 서비스 계정 JSON 키 파일 절대경로 (우선)
 *   GSC_SA_KEY_JSON   — 키 JSON 문자열 (base64 또는 raw JSON). 둘 중 하나.
 *   GSC_SITE_URL      — 기본 sc-domain:thundo.kr
 *   GSC_LOOKBACK_DAYS — 기본 3 (데이터 지연 보정 오프셋: 오늘-N일을 endDate로)
 *   GSC_ROLLING_DAYS  — 기본 4 (재수집 윈도우: endDate로부터 M일 소급)
 *
 * 크리덴셜 없으면 warn 로그 후 exit 0 (스킵, cron 에러 아님).
 * 빈 결과는 에러가 아니므로 warn 없이 info 로그 후 정상 종료.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { makeLogger } from '../lib/log.mjs';

import { isMainModule } from '../lib/main-module.mjs';
const log = makeLogger('seo-collect');

const SITE_URL      = process.env.GSC_SITE_URL      || 'sc-domain:thundo.kr';
const LOOKBACK      = parseInt(process.env.GSC_LOOKBACK_DAYS || '3', 10);
const ROLLING       = parseInt(process.env.GSC_ROLLING_DAYS  || '4', 10);
const METRICS_PATH  = 'state/seo-metrics.jsonl';
const ROW_LIMIT     = 5000;

// ── 키 로드 ──────────────────────────────────────────────────────────────────

function loadKey() {
  const keyPath = process.env.GSC_SA_KEY_PATH;
  const keyJson = process.env.GSC_SA_KEY_JSON;

  if (keyPath) {
    if (!existsSync(keyPath)) {
      log.warn(`GSC_SA_KEY_PATH 파일 없음: ${keyPath}`);
      return null;
    }
    try { return JSON.parse(readFileSync(keyPath, 'utf8')); }
    catch (e) { log.warn(`키 파일 JSON 파싱 실패: ${e.message}`); return null; }
  }

  if (keyJson) {
    try {
      const raw = keyJson.trimStart().startsWith('{')
        ? keyJson
        : Buffer.from(keyJson, 'base64').toString('utf8');
      return JSON.parse(raw);
    } catch (e) { log.warn(`GSC_SA_KEY_JSON 파싱 실패: ${e.message}`); return null; }
  }

  return null;
}

// ── 날짜 유틸 ────────────────────────────────────────────────────────────────

function isoDate(d) { return d.toISOString().slice(0, 10); }

function dateRange() {
  const now = new Date();
  const endDate = new Date(now);
  endDate.setUTCDate(endDate.getUTCDate() - LOOKBACK);
  const startDate = new Date(endDate);
  startDate.setUTCDate(startDate.getUTCDate() - ROLLING + 1);
  return { startDate: isoDate(startDate), endDate: isoDate(endDate) };
}

// ── seo-metrics.jsonl 헬퍼 (export: gsc-feedback, apply-targeting, cohort-report 공용) ─

/**
 * state/seo-metrics.jsonl 을 (date, dimension) 복합 키 Map으로 로드.
 * 같은 키가 여러 줄이면 파일의 마지막 레코드가 유효(upsert 의미론 준수).
 */
export function loadSeoMetrics(path = METRICS_PATH) {
  if (!existsSync(path)) return new Map();
  const map = new Map();
  const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      if (rec.date && rec.dimension) {
        map.set(`${rec.date}|${rec.dimension}`, rec);
      }
    } catch { /* 손상 줄 스킵 */ }
  }
  return map;
}

function upsertMetrics(newRecords) {
  const existing = loadSeoMetrics();
  for (const rec of newRecords) {
    existing.set(`${rec.date}|${rec.dimension}`, rec);
  }
  mkdirSync('state', { recursive: true });
  const content = [...existing.values()].map(r => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(METRICS_PATH, content, 'utf8');
}

// ── GSC API ──────────────────────────────────────────────────────────────────

async function getToken(keyJson) {
  const { JWT } = await import('google-auth-library');
  const auth = new JWT({
    email:  keyJson.client_email,
    key:    keyJson.private_key,
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });
  const resp = await auth.getAccessToken();
  return resp.token;
}

async function querySearchAnalytics(token, dimensions, startDate, endDate) {
  const encSiteUrl = encodeURIComponent(SITE_URL);
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encSiteUrl}/searchAnalytics/query`;
  const rows = [];
  let startRow = 0;

  for (;;) {
    const body = { startDate, endDate, dimensions, rowLimit: ROW_LIMIT, startRow };
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.warn(`GSC API ${res.status}: ${text.slice(0, 200)}`);
      break;
    }

    const data = await res.json();
    const chunk = data.rows || [];
    rows.push(...chunk);
    if (chunk.length < ROW_LIMIT) break;
    startRow += chunk.length;
  }

  return rows;
}

// GSC 행을 날짜별 레코드로 그룹화.
// 각 행 row.keys = [date, secondKey(page|query)].
function groupByDate(rows, dimension) {
  const byDate = new Map();
  for (const row of rows) {
    const [date, secondKey] = row.keys;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push({
      key:         secondKey,
      clicks:      row.clicks,
      impressions: row.impressions,
      ctr:         row.ctr,
      position:    row.position,
    });
  }

  const result = [];
  for (const [date, recs] of byDate) {
    result.push({
      date,
      dimension,
      rows:         recs,
      collected_at: new Date().toISOString(),
    });
  }
  return result;
}

// ── 메인 ─────────────────────────────────────────────────────────────────────

async function main() {
  const keyJson = loadKey();
  if (!keyJson) {
    log.warn('GSC 크리덴셜 없음 (GSC_SA_KEY_PATH 또는 GSC_SA_KEY_JSON 미설정) — 수집 스킵');
    process.exit(0);
  }

  const { startDate, endDate } = dateRange();
  log.info(`수집 범위: ${startDate} ~ ${endDate} (lookback=${LOOKBACK}, rolling=${ROLLING})`);

  let token;
  try {
    token = await getToken(keyJson);
  } catch (e) {
    log.warn(`토큰 발급 실패: ${e.message} — 수집 스킵`);
    process.exit(0);
  }

  const allRecords = [];

  try {
    log.info('page 차원 수집 중...');
    const pageRows = await querySearchAnalytics(token, ['date', 'page'], startDate, endDate);
    log.info(`page 차원 ${pageRows.length}행 수신`);
    allRecords.push(...groupByDate(pageRows, 'page'));
  } catch (e) {
    log.warn(`page 차원 수집 실패: ${e.message}`);
  }

  try {
    log.info('query 차원 수집 중...');
    const queryRows = await querySearchAnalytics(token, ['date', 'query'], startDate, endDate);
    log.info(`query 차원 ${queryRows.length}행 수신`);
    allRecords.push(...groupByDate(queryRows, 'query'));
  } catch (e) {
    log.warn(`query 차원 수집 실패: ${e.message}`);
  }

  if (allRecords.length === 0) {
    log.info('빈 결과 — 저장 스킵 (정상: GSC 갱신 지연 또는 신규 속성)');
    process.exit(0);
  }

  upsertMetrics(allRecords);
  log.info(`state/seo-metrics.jsonl upsert 완료: ${allRecords.length}레코드`);
}

// import 될 때는 실행하지 않음 (loadSeoMetrics 공용 헬퍼만 export)
if (isMainModule(import.meta.url)) {
  main().catch(e => { log.error(`치명 오류: ${e.message}`); process.exit(1); });
}
