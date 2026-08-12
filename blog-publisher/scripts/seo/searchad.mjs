/**
 * searchad.mjs — 네이버 검색광고 API "키워드도구" 클라이언트 (절대 월간검색량·연관키워드)
 *
 * ⚠ 공식 API(`api.searchad.naver.com`)만 호출한다. 인증은 HMAC-SHA256 서명:
 *   X-Signature = base64(HMAC_SHA256(비밀키, `${timestamp}.${METHOD}.${path}`))
 *   (path 는 쿼리스트링 제외. METHOD 대문자.)
 *
 * 데이터랩과의 차이: 데이터랩은 요청 내 상대비율(0~100)이라 앵커 정규화가 필요했지만,
 * 키워드도구는 **절대 월간 검색수**(PC+모바일)를 주고 **연관키워드**까지 돌려준다.
 * 점수 축은 기존과 동일하게 유지한다 — demand = 월간검색수 ÷ 앵커 월간검색수.
 * (기존 tier·min_score 설정이 그대로 의미를 갖도록.)
 *
 * 실측 주의(문서화된 함정):
 *   - hintKeywords 는 콜당 최대 5개, **공백 불허** → toHint() 로 제거해 보낸다.
 *   - 응답 relKeyword 도 공백 제거형이라 원본 키워드와 매칭하려면 normKey() 로 양쪽 정규화.
 *   - 저볼륨은 숫자 대신 "< 10" 문자열 → parseCount() 가 5 로 해석.
 *
 * 계약: RUN_MODE=mock → 결정론 합성(네트워크 0회). 크리덴셜 없음 → 호출측이 null 판단.
 */
import crypto from 'node:crypto';
import { makeLogger } from '../lib/log.mjs';
import { isMockMode } from './naver-search.mjs';

const log = makeLogger('searchad');

const BASE = 'https://api.searchad.naver.com';
const PATH = '/keywordstool';
export const HINTS_PER_CALL = 5;

/** HMAC-SHA256 서명 (순수 — 테스트 벡터로 고정). */
export function signature(secret, timestamp, method, path) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${method}.${path}`).digest('base64');
}

export function loadSearchAdCreds() {
  const key      = process.env.NAVER_SEARCHAD_API_KEY;
  const secret   = process.env.NAVER_SEARCHAD_SECRET;
  const customer = process.env.NAVER_SEARCHAD_CUSTOMER_ID;
  return (key && secret && customer) ? { key, secret, customer } : null;
}

/** "< 10" 같은 저볼륨 표기 → 5, 숫자/숫자문자열 → 숫자, 그 외 → 0. 순수. */
export function parseCount(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = String(v ?? '').trim();
  if (s.startsWith('<')) return 5;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** hintKeywords 전송형 — 공백 제거(API 가 공백 포함 키워드를 거부한다). 순수. */
export function toHint(kw) { return String(kw).replace(/\s+/g, ''); }

/** 응답 relKeyword ↔ 원본 키워드 매칭 키 — 공백 제거 + 소문자. 순수. */
export function normKey(kw) { return String(kw).replace(/\s+/g, '').toLowerCase(); }

/** 결정론 해시 — mock 볼륨 합성용. */
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

async function callKeywordTool(hints, creds) {
  const ts = String(Date.now());
  const qs = new URLSearchParams({ hintKeywords: hints.join(','), showDetail: '1' });
  const res = await fetch(`${BASE}${PATH}?${qs}`, {
    headers: {
      'X-Timestamp': ts,
      'X-API-KEY':   creds.key,
      'X-Customer':  String(creds.customer),
      'X-Signature': signature(creds.secret, ts, 'GET', PATH),
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`keywordstool HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return Array.isArray(data.keywordList) ? data.keywordList : [];
}

function mockKeywordList(hints) {
  // 힌트 자신 + 힌트당 연관 2개를 결정론 합성.
  const rows = [];
  for (const h of hints) {
    rows.push({ relKeyword: h, monthlyPcQcCnt: hashStr(h) % 5000, monthlyMobileQcCnt: hashStr(`${h}|m`) % 20000, compIdx: '중간' });
    rows.push({ relKeyword: `${h}추천`, monthlyPcQcCnt: hashStr(`${h}|r1`) % 3000, monthlyMobileQcCnt: hashStr(`${h}|r1m`) % 9000, compIdx: '낮음' });
    rows.push({ relKeyword: `${h}방법`, monthlyPcQcCnt: '< 10', monthlyMobileQcCnt: hashStr(`${h}|r2m`) % 800, compIdx: '높음' });
  }
  return rows;
}

/**
 * 키워드들의 절대 월간검색량 + 연관키워드 조회.
 *
 * @returns {Promise<{stats:Map<string,{total:number,pc:number,mobile:number,comp:string}>,
 *                    related:Array<{keyword:string,total:number}>, calls:number, failures:number}>}
 *   stats 키는 normKey() 정규화형. related 는 요청 키워드에 없던 것만(정규화 dedup).
 */
export async function fetchKeywordStats(keywords, { creds, requestDelayMs = 300 } = {}) {
  const mock = isMockMode();
  const hints = [...new Set(keywords.map(toHint).filter(h => h.length >= 2))];
  const requested = new Set(keywords.map(normKey));

  const stats = new Map();
  const relatedMap = new Map();
  let calls = 0, failures = 0;

  for (let i = 0; i < hints.length; i += HINTS_PER_CALL) {
    const batch = hints.slice(i, i + HINTS_PER_CALL);
    calls++;
    let rows;
    try {
      rows = mock ? mockKeywordList(batch) : await callKeywordTool(batch, creds);
    } catch (e) {
      failures++;
      log.warn(`키워드도구 배치 실패(${batch.length}개 건너뜀): ${e.message}`);
      continue;
    }
    for (const row of rows) {
      const k = normKey(row.relKeyword || '');
      if (!k) continue;
      const pc = parseCount(row.monthlyPcQcCnt);
      const mobile = parseCount(row.monthlyMobileQcCnt);
      const entry = { total: pc + mobile, pc, mobile, comp: String(row.compIdx ?? '') };
      if (requested.has(k)) {
        stats.set(k, entry);
      } else if (!relatedMap.has(k) || relatedMap.get(k).total < entry.total) {
        relatedMap.set(k, { keyword: String(row.relKeyword), total: entry.total });
      }
    }
    // 순차 + 짧은 간격 — 검색광고 API 레이트리밋 예의(버스트 금지).
    if (!mock && i + HINTS_PER_CALL < hints.length) await new Promise(r => setTimeout(r, requestDelayMs));
  }

  const related = [...relatedMap.values()].sort((a, b) => b.total - a.total);
  return { stats, related, calls, failures };
}
