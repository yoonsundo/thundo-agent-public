#!/usr/bin/env node
/**
 * shorts-curiosity/reddit-seed.mjs — "실제로 흥미가 검증된" 사실 씨앗 수집
 *
 * 호기심 채널 아이디어의 관심 근거를 LLM 상상이 아니라 **실제 인기 데이터**로 잡는다.
 * r/todayilearned·r/Damnthatsinteresting 등 "흥미로운 사실" 서브레딧의 **주간 top**을
 * RSS(.rss)로 수집 — /top/ 피드의 순위 자체가 업보트(관심) 랭킹이다(RSS엔 점수 없음).
 *
 * 채널 분리: 블로그 reddit/fetch.mjs(seen·runs 상태 결합)와 독립. 자체 fetch+파싱.
 * .json 은 데이터센터 IP 403 → RSS Atom 만 사용(블로그와 동일 실측 근거).
 *
 * @returns seeds: [{ title, fact, url, subreddit, rank }]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { makeLogger } from '../lib/log.mjs';
import { paths } from '../lib/config.mjs';

const log = makeLogger('curiosity/reddit-seed');

const UA = process.env.REDDIT_USER_AGENT
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Atom 피드에서 {title, url} 추출(정규식 — 의존성 없이). */
export function parseAtom(xml) {
  const out = [];
  const entries = String(xml).split(/<entry>/).slice(1);
  for (const e of entries) {
    const t = e.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    const l = e.match(/<link[^>]*href="([^"]+)"/);
    if (!t) continue;
    const title = decodeEntities(t[1].trim());
    const url = l ? l[1] : '';
    if (title) out.push({ title, url });
  }
  return out;
}

function decodeEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&amp;/g, '&').trim();
}

/** "TIL that ..."/"TIL: ..." 접두를 벗겨 순수 사실 문장만 남김. */
export function stripTil(title) {
  return title
    .replace(/^TIL\s*(that|about|:|,)?\s*/i, '')
    .replace(/^\s*that\s+/i, '')
    .trim();
}

async function fetchFeed(sub, { timeframe = 'week', limit = 20 } = {}) {
  const url = `https://www.reddit.com/r/${sub}/top/.rss?t=${timeframe}&limit=${limit}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/atom+xml,text/xml' } });
      if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
      if (res.status !== 200) { log.warn(`r/${sub} HTTP ${res.status}`); return []; }
      const xml = await res.text();
      return parseAtom(xml);
    } catch (e) {
      log.warn(`r/${sub} fetch 실패(재시도 ${attempt + 1}): ${e.message}`);
      await sleep(1500 * (attempt + 1));
    }
  }
  // ⚠ 재시도 소진(주로 HTTP 429)은 "피드가 비었다"와 구별돼야 한다 — 조용히 []를 돌려주면
  // 씨앗 고갈(→ LLM 오리지널·whatif 편중)의 원인이 로그에서 사라진다.
  log.warn(`r/${sub} 재시도 소진(429/네트워크) → 씨앗 0건`);
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// 주간 top 창(window) 중복 억제
//
// `/top/.rss?t=week` 는 **최대 7일간 같은 글을 반환**한다. 보충 주기가 2~3일이라 같은 원문이
// 반복 수집되는 게 정상 동작이고, 이게 07-27/07-29 중복 업로드("총알 없는 총으로 자기 머리를
// 쐈던 배우" ↔ 같은 주제 + '(공포탄의 진실)")의 원인 중 하나다. 백로그 dedup 은 한국어 재작성
// **결과**의 sha1 이라 원문이 같아도 문구가 달라지면 통과해 버린다 → 원문 단계에서 막는다.
//
// 재작성 전 씨앗 단계에서: ① 같은 배치 내 교차게시 중복은 **제거**(한 프롬프트에 같은 이야기를
// 두 번 넣는 건 순수 낭비) ② 최근 window_days 안에 이미 프롬프트로 넘긴 원문은 **뒤로 밀기**
// (deprioritize). 기록은 state/shorts-curiosity-reddit-seen.json (키=글 URL, 값=최초 관찰시각).
//
// ⚠ ②를 "제외"로 하지 않는 이유: collectSeeds 는 서브레딧 5개 × 20위 ≈ 100건을 모으지만
// backlog.mjs 는 그중 앞 30건만 프롬프트에 넘기고 실제 백로그가 되는 건 ~7건이다. 관찰한 걸
// 다 지워버리면 1~2회 보충 만에 reddit 씨앗이 말라 **LLM 오리지널(=whatif 출처)만 남고 앵글
// 편중이 오히려 악화**된다. 순서만 바꾸면 신선한 원문이 항상 프롬프트 앞자리를 차지하고,
// 신규가 모자랄 때는 기존 원문이 자리를 채워 소재 고갈이 없다(무해한 실패 모드).
// 최초 관찰시각은 갱신하지 않는다 → window_days 지나면 완전한 신규로 복귀.
// ─────────────────────────────────────────────────────────────────────────────

const SEEN_TTL_DAYS = 90;      // 이보다 오래된 기록은 파일에서 정리(무한 증식 방지)

export function seenPath() {
  return process.env.CURIOSITY_REDDIT_SEEN_PATH || join(paths.state, 'shorts-curiosity-reddit-seen.json');
}

/** 씨앗 식별키 — reddit 글 URL(쿼리·꼬리 슬래시 제거), URL 이 없으면 사실 문장 해시. */
export function seedKey(seed) {
  const url = String(seed?.url || '').trim();
  if (url) return url.split('?')[0].split('#')[0].replace(/\/+$/, '');
  return 'fact:' + createHash('sha1').update(normalizeFact(seed?.fact || seed?.title || '')).digest('hex').slice(0, 16);
}

/** 비교용 정규화 — 소문자화 + 영문/숫자만(구두점·공백 차이 흡수). */
function normalizeFact(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9가-힣\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 어절(단어) 집합 Jaccard — 영어 원문 비교라 문자 bigram 보다 오탐이 적다. */
export function factSimilarity(a, b) {
  const A = new Set(normalizeFact(a).split(' ').filter(w => w.length > 2));
  const B = new Set(normalizeFact(b).split(' ').filter(w => w.length > 2));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/** 같은 배치 내 중복(같은 글이 여러 서브레딧에 교차게시) 제거 — 상위 랭크 우선 보존. */
export function dedupeSeedBatch(seeds, { word_jaccard = 0.6 } = {}) {
  const kept = [];
  const keys = new Set();
  for (const s of seeds) {
    const k = seedKey(s);
    if (keys.has(k)) continue;
    if (kept.some(o => factSimilarity(o.fact, s.fact) >= word_jaccard)) continue;
    keys.add(k); kept.push(s);
  }
  return kept;
}

/**
 * 최근 window_days 안에 이미 프롬프트로 넘긴 원문을 뒤로 밀고(순서만 변경), 앞자리
 * mark_limit 건(= backlog.mjs 가 프롬프트에 넘기는 분량)을 관찰 기록에 남긴다.
 * 건수는 줄지 않는다 — 소재 고갈 방지.
 * @returns { seeds(재정렬), deferred(뒤로 밀린 수), marked, store(갱신된 기록) }
 */
export function orderSeedsBySeen(seeds, store = {}, { window_days = 8, mark_limit = 30, now = new Date() } = {}) {
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const next = { ...store };
  const fresh = [], stale = [];
  for (const s of seeds) {
    const firstSeen = next[seedKey(s)] ? Date.parse(next[seedKey(s)]) : NaN;
    const withinWindow = Number.isFinite(firstSeen) && (nowMs - firstSeen) < window_days * 86_400_000;
    (withinWindow ? stale : fresh).push(s);
  }
  const ordered = [...fresh, ...stale];
  // 프롬프트가 실제로 볼 앞자리만 "넘겼다"고 기록(관찰만 한 뒷자리는 남기지 않는다).
  let marked = 0;
  for (const s of ordered.slice(0, Math.max(0, mark_limit))) {
    const k = seedKey(s);
    if (!next[k]) { next[k] = new Date(nowMs).toISOString(); marked++; }
  }
  // TTL 정리 — 오래된 기록은 버린다.
  for (const [k, v] of Object.entries(next)) {
    const t = Date.parse(v);
    if (!Number.isFinite(t) || (nowMs - t) > SEEN_TTL_DAYS * 86_400_000) delete next[k];
  }
  return { seeds: ordered, deferred: stale.length, marked, store: next };
}

export function loadSeenStore() {
  try {
    const p = seenPath();
    if (!existsSync(p)) return {};
    const obj = JSON.parse(readFileSync(p, 'utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch (e) { log.warn(`씨앗 기록 읽기 실패(무시): ${e.message}`); return {}; }
}

export function saveSeenStore(store) {
  try {
    const p = seenPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(store, null, 2) + '\n', 'utf8');
  } catch (e) { log.warn(`씨앗 기록 저장 실패(무시): ${e.message}`); }
}

/**
 * 설정된 서브레딧들의 주간 top 을 순위 보존하며 수집.
 * @returns {Promise<Array<{title,fact,url,subreddit,rank}>>}
 */
export async function collectSeeds(cfg) {
  const rs = cfg.backlog?.reddit_seed || {};
  if (rs.enabled === false) return [];
  const subs = rs.subreddits || ['todayilearned', 'Damnthatsinteresting', 'interestingasfuck', 'YouShouldKnow'];
  const timeframe = rs.timeframe || 'week';
  const limit = rs.limit || 20;

  const seeds = [];
  for (let i = 0; i < subs.length; i++) {
    if (i > 0) await sleep(2500); // rate-limit 예방(블로그 fetch 와 동일 간격)
    const sub = subs[i];
    const entries = await fetchFeed(sub, { timeframe, limit });
    log.info(`r/${sub}: ${entries.length}개 top 항목`);
    entries.forEach((e, idx) => {
      const fact = sub.toLowerCase() === 'todayilearned' ? stripTil(e.title) : e.title;
      if (fact && fact.length > 12) {
        seeds.push({ title: e.title, fact, url: e.url, subreddit: sub, rank: idx + 1 });
      }
    });
  }
  // 주간 top 창 중복 억제(배치 내 교차게시 + 최근 이미 넘긴 원문).
  const dd = rs.dedup || {};
  if (dd.enabled === false) {
    log.info(`총 ${seeds.length}개 씨앗 수집(실제 인기 검증, 창중복 억제 off)`);
    return seeds;
  }
  const batch = dedupeSeedBatch(seeds, { word_jaccard: dd.word_jaccard ?? 0.6 });
  const { seeds: ordered, deferred, marked, store } = orderSeedsBySeen(batch, loadSeenStore(), {
    window_days: dd.window_days ?? 8,
    mark_limit: dd.mark_limit ?? 30,
  });
  saveSeenStore(store);
  log.info(`총 ${seeds.length}개 수집 → 배치중복 ${seeds.length - batch.length}건 제거, 최근수집 ${deferred}건 후순위(신규 ${batch.length - deferred}건 우선), 기록 ${marked}건`);
  return ordered;
}

export function isMainModule(metaUrl) {
  return process.argv[1] && metaUrl === `file://${process.argv[1]}`;
}

async function main() {
  const { loadConfig } = await import('./lib.mjs');
  const seeds = await collectSeeds(loadConfig());
  process.stdout.write(JSON.stringify({ ok: true, count: seeds.length, seeds: seeds.slice(0, 40) }, null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
