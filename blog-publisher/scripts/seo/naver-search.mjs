/**
 * naver-search.mjs — 네이버 검색 OpenAPI 클라이언트 (합법 순위추적용 공용 모듈)
 *
 * ⚠ 스크래핑·탐지회피 절대 금지. 공식 검색 API(문서화·키기반·약관준수)만 호출한다.
 *   네이버 통합검색 화면(광고·블록 포함) 순위와 100% 일치하진 않으나, 공식·안정 신호로
 *   시간에 따른 순위 추세 추적에 충분하다.
 *
 * provider 전환형: config.api.provider = 'developer' | 'apihub'
 *   - developer : 개발자센터 openapi.naver.com (2027-06-30 지원종료 예정)
 *   - apihub    : NAVER API HUB(NCP) 이관 경로 (base_url 확정 후 사용)
 *   두 경로 모두 X-Naver-Client-Id / X-Naver-Client-Secret 헤더 방식(현행).
 *
 * 크리덴셜 없음 또는 RUN_MODE=mock → 합성 데이터(비차단). GSC gsc-collect 와 동일 계약.
 *
 * env:
 *   NAVER_CLIENT_ID / NAVER_CLIENT_SECRET  — 개발자센터 키 (provider=developer)
 *   NAVER_APIHUB_CLIENT_ID / _SECRET       — API HUB 키   (provider=apihub)
 *   RUN_MODE=mock                          — 강제 합성 데이터
 */
import { readFileSync, existsSync } from 'node:fs';
import { makeLogger } from '../lib/log.mjs';

const log = makeLogger('naver-search');

const CONFIG_PATH = 'config/naver-seo.json';

export function loadNaverSeoConfig(path = CONFIG_PATH) {
  if (!existsSync(path)) throw new Error(`설정 없음: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** 활성 provider 의 api 설정 블록 반환. */
export function resolveApi(cfg) {
  const provider = cfg?.api?.provider || 'developer';
  const block = cfg?.api?.[provider];
  if (!block) throw new Error(`알 수 없는 provider: ${provider}`);
  return { provider, ...block };
}

/** 활성 provider 의 크리덴셜을 env 에서 읽음. 없으면 null. */
export function loadCreds(cfg) {
  const api = resolveApi(cfg);
  const id = process.env[api.id_env];
  const secret = process.env[api.secret_env];
  if (!id || !secret) return null;
  return { id, secret, api };
}

export function isMockMode() {
  return process.env.RUN_MODE === 'mock';
}

/** 문자열 결정론 해시(0..2^32) — mock 순위 합성에 사용(런마다 흔들리지 않게). */
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** URL 의 host 가 우리 도메인 별칭 중 하나와 일치하는지. */
function hostMatches(link, aliases) {
  let host;
  try { host = new URL(link).hostname.toLowerCase(); }
  catch { return false; }
  return aliases.some(a => {
    const al = String(a).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    return host === al || host === `www.${al}` || (al.startsWith('www.') && host === al.slice(4));
  });
}

/**
 * items(검색결과 배열, 각 {link}) 에서 우리 도메인이 처음 등장하는 1-기반 순위.
 * 없으면 null.
 */
export function findRank(items, aliases) {
  for (let i = 0; i < items.length; i++) {
    if (hostMatches(items[i].link || '', aliases)) return i + 1;
  }
  return null;
}

/** 합성 검색결과: 일부 (query,type) 조합에서만 우리 도메인이 노출되게. 결정론적. */
function mockSearch(type, query, cfg) {
  const display = cfg.display || 30;
  const seed = hashStr(`${type}|${query}`);
  const items = [];
  // seed 로 우리 도메인 노출 여부·위치 결정 (약 60% 노출, 위치 1..display)
  const appears = (seed % 5) !== 0;              // 80% 노출
  const ourPos = appears ? (seed % display) + 1 : -1;
  for (let i = 1; i <= display; i++) {
    if (i === ourPos) {
      items.push({ title: `[mock] ${query} — thundo`, link: `https://${cfg.our_domain}/blog/mock-${seed % 97}` });
    } else {
      items.push({ title: `[mock] ${query} 결과 ${i}`, link: `https://example${(seed + i) % 50}.com/p/${i}` });
    }
  }
  return items;
}

/**
 * 한 (type, query) 검색 → items 배열. mock/크리덴셜없음이면 합성.
 * type: 'webkr' | 'blog' | 'news' ... (네이버 검색 API 카테고리)
 */
export async function searchNaver(type, query, { cfg, creds } = {}) {
  cfg = cfg || loadNaverSeoConfig();
  if (isMockMode() || !creds) {
    return { items: mockSearch(type, query, cfg), mock: true };
  }
  const { api } = creds;
  const url = `${api.base_url}/${type}.json?query=${encodeURIComponent(query)}&display=${cfg.display || 30}`;
  const res = await fetch(url, {
    headers: {
      [api.id_header]: creds.id,
      [api.secret_header]: creds.secret,
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    log.warn(`네이버 검색 API ${res.status} (${type}/${query}): ${text.slice(0, 160)}`);
    return { items: [], mock: false, error: res.status };
  }
  const data = await res.json();
  const items = (data.items || []).map(it => ({ title: it.title, link: it.link }));
  return { items, mock: false };
}
