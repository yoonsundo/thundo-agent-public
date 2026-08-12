/**
 * datalab.mjs — 네이버 데이터랩 "통합검색어 트렌드" 공식 API 클라이언트
 *
 * ⚠ 공식 OpenAPI(`POST /v1/datalab/search`)만 호출한다. 자동완성·연관검색어 등
 *   비공식 엔드포인트는 스크래핑과 같은 벽(약관·차단·유지보수 지옥)이라 금지.
 *
 * 크리덴셜: 검색 API 와 같은 개발자센터 앱 키(NAVER_CLIENT_ID/SECRET) 재사용.
 *   ⚠ 단, 앱에 "데이터랩(검색어트렌드)" API 를 추가 등록해야 한다(1회·무료·일 1,000콜).
 *   미등록이면 HTTP 403/401 이 온다 — 호출측 계약대로 warn+exit 0 으로 흘려보낸다.
 *
 * 제약과 해법:
 *   - 요청당 keywordGroups 최대 5개, ratio 는 **요청 내 최대값=100 인 상대값**이라
 *     배치가 다르면 서로 비교할 수 없다. → 전 배치에 앵커 키워드를 끼워 넣고
 *     `점수 = 그룹 평균 ratio ÷ 그 배치의 앵커 평균 ratio` 로 정규화한다(앵커 배율).
 *   - 앵커의 ratio 가 0(수요 없음)인 배치는 정규화 불능 → 해당 배치 키워드는 null 점수.
 *
 * 계약: RUN_MODE=mock → 결정론 합성 ratio(네트워크 0회). 크리덴셜 없음 → null 반환(호출측 판단).
 */
import { makeLogger } from '../lib/log.mjs';
import { isMockMode } from './naver-search.mjs';

const log = makeLogger('datalab');

const ENDPOINT = 'https://openapi.naver.com/v1/datalab/search';
const MAX_GROUPS_PER_CALL = 5;
/** 앵커가 1자리를 차지하므로 실제 후보는 콜당 4개씩 나간다. */
export const CANDIDATES_PER_CALL = MAX_GROUPS_PER_CALL - 1;

/** 문자열 결정론 해시 — mock ratio 합성용(naver-search.mjs 와 동일 패턴). */
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** YYYY-MM-DD (KST 무관 — 데이터랩은 일 단위라 UTC 로 충분). */
function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

/** 후보 배열 → 앵커 포함 배치들. 순수함수. */
export function planBatches(candidates, anchor) {
  const uniq = [...new Set(candidates.map(k => String(k).trim().toLowerCase()).filter(Boolean))]
    .filter(k => k !== anchor);
  const batches = [];
  for (let i = 0; i < uniq.length; i += CANDIDATES_PER_CALL) {
    batches.push([anchor, ...uniq.slice(i, i + CANDIDATES_PER_CALL)]);
  }
  return batches;
}

/**
 * 배치 응답들 → 키워드별 앵커 배율 점수. 순수함수.
 *
 * @param {Array<{keywords:string[], results:Array<{title:string, ratios:number[]}>}>} batchResults
 * @param {string} anchor
 * @returns {Map<string, number|null>} keyword → score (앵커 평균 대비 배율, 앵커 자신 제외)
 */
export function normalizeWithAnchor(batchResults, anchor) {
  const out = new Map();
  for (const batch of batchResults) {
    const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
    const anchorRow = batch.results.find(r => r.title === anchor);
    const anchorMean = anchorRow ? mean(anchorRow.ratios) : 0;
    for (const row of batch.results) {
      if (row.title === anchor) continue;
      // 앵커 0 → 이 배치는 비교 기준이 없다. null 로 표시(0점 아님 — 측정 불능).
      out.set(row.title, anchorMean > 0 ? mean(row.ratios) / anchorMean : null);
    }
    // 요청한 키워드 중 응답에 아예 없는 것(데이터랩이 수요 미달로 누락) = 수요 사실상 0.
    for (const kw of batch.keywords) {
      if (kw !== anchor && !out.has(kw)) out.set(kw, 0);
    }
  }
  return out;
}

/** 단일 배치 호출. 실패는 throw — 호출측이 배치 단위로 삼킨다. */
async function callDatalab(groupKeywords, { creds, startDate, endDate, timeUnit }) {
  const body = {
    startDate, endDate, timeUnit,
    keywordGroups: groupKeywords.map(k => ({ groupName: k, keywords: [k] })),
  };
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'X-Naver-Client-Id': creds.id,
      'X-Naver-Client-Secret': creds.secret,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    // 타임아웃 필수 — 없으면 응답 지연 시 주간 프로세스가 flock 을 쥔 채 매달리고,
    // 이후 모든 일요일이 "이미 실행 중" rc 0 스킵이 된다(무음 실패의 락 경로 변종).
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`datalab HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.results || []).map(r => ({
    title: r.title,
    ratios: (r.data || []).map(p => Number(p.ratio) || 0),
  }));
}

/** mock 배치 — 키워드 해시로 결정론 ratio 합성(앵커는 항상 유의미한 값). */
function mockBatch(groupKeywords, anchor) {
  return groupKeywords.map(k => ({
    title: k,
    ratios: k === anchor
      ? [40, 50, 60]
      : [hashStr(k) % 90, hashStr(`${k}|2`) % 90, hashStr(`${k}|3`) % 90],
  }));
}

/**
 * 후보 키워드들의 수요 점수(앵커 배율)를 잰다.
 *
 * @returns {Promise<{scores: Map<string, number|null>, calls: number, failures: number}|null>}
 *   null = 크리덴셜 없음(mock 아님) — 호출측이 warn+exit 0.
 */
export async function fetchDemandScores(candidates, { anchor, lookbackDays = 90, timeUnit = 'week', creds }) {
  const mock = isMockMode();
  if (!mock && !creds) return null;

  const end = new Date(Date.now() - 24 * 3600 * 1000);            // 어제까지(당일은 집계 미완)
  const start = new Date(end.getTime() - lookbackDays * 24 * 3600 * 1000);
  const opts = { creds, startDate: isoDate(start), endDate: isoDate(end), timeUnit };

  const batches = planBatches(candidates, anchor);
  const batchResults = [];
  let failures = 0;
  for (const keywords of batches) {
    try {
      const results = mock ? mockBatch(keywords, anchor) : await callDatalab(keywords, opts);
      batchResults.push({ keywords, results });
    } catch (e) {
      // 배치 하나가 죽어도 나머지는 살린다 — 부분 데이터가 무데이터보다 낫다.
      failures++;
      log.warn(`데이터랩 배치 실패(${keywords.length}개 건너뜀): ${e.message}`);
    }
  }
  return { scores: normalizeWithAnchor(batchResults, anchor), calls: batches.length, failures };
}
