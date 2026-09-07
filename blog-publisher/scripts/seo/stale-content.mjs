#!/usr/bin/env node
/**
 * seo/stale-content.mjs — 검색 노출을 한 번도 못 받은 발행글 후보 분류 (읽기 전용)
 *
 * 왜 있는가: 발행물 203편 중 다수가 68일간 어떤 검색어에도 걸리지 않았다.
 * 구글 8월 스팸 업데이트의 표적("편집 감독 없는 대량 생산")과 우리 프로필이 겹치므로,
 * 죽은 글을 정리·통합해 사이트 전체의 신호를 정리할 필요가 생겼다.
 *
 * 🔴 **이 스크립트는 아무것도 지우지 않는다.** 목록만 만든다. 삭제·병합은 사람이 읽고
 *    승인한다. 그래서 산출물은 JSON 하나(state/stale-content.json)와 사람이 읽는
 *    마크다운 리포트 하나다. 분류가 자동으로 정답일 수 없기 때문에, 모든 항목에
 *    **왜 그 분류인지 근거 수치**를 같이 싣는다.
 *
 * 데이터 계약
 *  - state/seo-metrics.jsonl 은 같은 (날짜, dimension) 키가 여러 줄일 수 있고 **마지막 줄이
 *    이긴다.** 원본 줄을 직접 합치면 이중 계산이 되므로 gsc-collect 의 loadSeoMetrics() 를
 *    쓴다(정본 하나).
 *  - state/naver-rank.jsonl 은 ranks[].rank 가 null 이 아닐 때만 노출로 친다. null 은
 *    "순위 없음"이 아니라 "display 상한(30) 밖" 이므로 0 과 구분해 기록한다.
 *
 * ⚠ **0 과 null 을 구분한다.** GSC 수집에는 결손일이 있다(2026-09-07 기준 66일 구간에
 *   12일 미수집). 그 날짜의 노출은 "0회"가 아니라 **모른다**. 그래서 meta.gsc.missing_days 를
 *   산출물에 싣고, drop 판정은 결손일을 감안한 보수적 유예(grace)를 거친 뒤에만 낸다.
 *
 * 사용:
 *   node scripts/seo/stale-content.mjs                # 산출물 생성
 *   node scripts/seo/stale-content.mjs --dry-run      # 파일 안 쓰고 요약만
 *   node scripts/seo/stale-content.mjs --calibrate    # 유사도 분포 덤프(임계 근거용)
 *
 * exit 0=정상, 2=실행오류.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSeoMetrics } from './gsc-collect.mjs';
import { listPublishedSlugs, parseDoc } from '../lib/published-doc.mjs';
import { charFourgrams } from '../kernel/minhash.mjs';
import { stripJosa, collapse } from '../kernel/korean.mjs';
import { isMainModule } from '../lib/main-module.mjs';
import { makeLogger } from '../lib/log.mjs';

const log = makeLogger('seo/stale-content');

const __dir = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dir, '../../');

export const DEFAULTS = {
  metricsPath: join(REPO_ROOT, 'state', 'seo-metrics.jsonl'),
  naverPath:   join(REPO_ROOT, 'state', 'naver-rank.jsonl'),
  configPath:  join(REPO_ROOT, 'config', 'pipeline.json'),
  outJson:     join(REPO_ROOT, 'state', 'stale-content.json'),
  outReport:   join(REPO_ROOT, 'docs', 'reports', 'seo', 'stale-content.md'),
  /** 색인·수집이 자리잡는 데 필요한 최소 일수. 이보다 어린 글은 drop 후보에서 뺀다. */
  graceDays: 14,

  // ── 유사도 임계 (--calibrate 로 실측해 고른 값) ─────────────────────────────
  // 2026-09-07 발행물 203편 = 쌍 20,503개의 소재유사도 분포:
  //   p50=0.007 · p90=0.044 · p99=0.103 · p99.9=0.174 · p99.99=0.343
  // 즉 대부분의 쌍은 남남이고, 의미 있는 겹침은 상위 0.1% 꼬리에만 있다.
  //
  // merge 는 **넉넉하게** 잡는다. 잘못 묶인 쌍의 비용은 사람이 한 번 들여다보는 것이지만,
  // 놓친 중복의 비용은 그 글이 drop 후보로 흘러가 따로 처리되는 것이다. 비대칭이 명확하다.

  /** 같은 소재(merge). 0.22 → 10쌍. 실측 상위 10쌍은 전부 같은 주제였다
   *  (KIS API 레이트리밋 2편 · MCP 커스텀서버 2편 · Claude API 비용절감 2편 ·
   *   freqtrade 백테스트엔진 비교 2편 · zapier/make/n8n 2편 · 로컬LLM 비용 2편 …).
   *  0.25 로 올리면 zapier/make/n8n 쌍과 로컬LLM 쌍을 놓친다(6쌍). */
  mergeTopic: 0.22,

  /** 제목 문자 4-gram 자카드(kernel/minhash 의 charFourgrams 재사용).
   *  왜 따로 필요한가: `backtest-slippage-modeling-4-stage` ↔
   *  `backtest-slippage-4-stage-latency-breakdown` 은 누가 봐도 같은 소재인데
   *  소재유사도는 0.164 에 그친다(제목 어휘가 서로 달라서). 표현 관문이 이걸 잡는다.
   *  0.25 → 2쌍. 0.28 이상은 0쌍이라 관문이 죽는다. */
  mergeWording: 0.25,

  /** 태그 자카드 관문. 태그는 사람이 붙인 주제 라벨이라 제목보다 신호가 곧다.
   *  0.6 → 2쌍(n8n 자동화 2편 tags=0.8 · 백테스트엔진 리뷰 2편 tags=0.6). 둘 다 진짜다. */
  mergeTags: 0.6,

  /** 인접 소재(improve 근거 ①). p99=0.103 → **상위 1% 근접쌍**이라는 뜻으로 0.10 을 쓴다.
   *  0.08 로 낮추면 drop 이 25편으로 줄지만 "인접"의 의미가 희석되고,
   *  0.15 로 올리면 인접 판정이 4편으로 사실상 죽는다. */
  relatedTopic: 0.10,

  /** 소재 관문에 필요한 최소 공유 내용어 — 낱말 하나가 우연히 겹쳐 넘는 것 방지.
   *  호기심 쇼츠 재탕 관문(shorts-curiosity/pick.mjs)에서 검증된 같은 장치다. */
  minSharedTokens: 2,

  /** improve 근거 ②: 현재 니치 타겟팅 키워드 가중치 하한. w1 은 '자동화'처럼 너무 넓다. */
  nicheWeightMin: 2,
};

// ── frontmatter 읽기 ─────────────────────────────────────────────────────────

/**
 * frontmatter 의 리스트 필드를 읽는다.
 *
 * 왜 parseDoc 로 부족한가: parseDoc 은 `key: value` 한 줄만 본다. 실제 published/ 에는
 * 리스트가 **세 가지 모양**으로 섞여 있다(2026-09-07 실측).
 *   ① tags: ["자동화", "생산성"]      ← JSON 배열
 *   ② tags: [팩터투자, AI에이전트]     ← 따옴표 없는 flow 리스트 (JSON.parse 실패)
 *   ③ tags:\n  - 퀀트트레이딩          ← 블록 리스트 (parseDoc 은 빈 문자열로 본다)
 * 셋을 다 못 읽으면 8편이 "태그 없음"으로 잘못 집계돼 분류가 통째로 틀어진다.
 *
 * @param {string} raw 문서 전문
 * @param {string} key 필드명
 * @returns {string[]} 항목 배열(못 찾으면 빈 배열)
 */
export function readListField(raw, key) {
  const fmMatch = String(raw || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return [];
  const lines = fmMatch[1].split(/\r?\n/);
  const head = new RegExp(`^${key}:\\s*(.*)$`);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(head);
    if (!m) continue;
    const inline = m[1].trim();
    if (inline.startsWith('[')) {
      try { return JSON.parse(inline).map(String).map(s => s.trim()).filter(Boolean); }
      catch { /* 따옴표 없는 flow 리스트 → 수동 분해 */ }
      return inline.replace(/^\[|\]$/g, '').split(',')
        .map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    }
    if (inline) return [inline.replace(/^["']|["']$/g, '')];
    // 블록 리스트: 다음 줄부터 들여쓴 `- item` 이 이어진다.
    const out = [];
    for (let j = i + 1; j < lines.length; j++) {
      const item = lines[j].match(/^\s+-\s+(.*)$/);
      if (!item) break;
      const v = item[1].trim().replace(/^["']|["']$/g, '');
      if (v) out.push(v);
    }
    return out;
  }
  return [];
}

/** published/ 전편을 {slug,date,title,tags,description,file} 로 읽는다. */
export function loadPosts(dir) {
  const list = dir ? listPublishedSlugsIn(dir) : listPublishedSlugs();
  return list.map(({ slug, date, file }) => {
    const raw = readFileSync(file, 'utf8');
    const { fm } = parseDoc(raw);
    return {
      slug,
      date,                                  // 파일명 날짜가 정본(frontmatter 는 흔들린다)
      title: fm.title || slug,
      description: fm.description || '',
      tags: readListField(raw, 'tags'),
      file,
      bytes: Buffer.byteLength(raw, 'utf8'),
    };
  });
}

/** 테스트 격리용 — published-doc 의 규약(<YYYY-MM-DD>-<slug>.md)을 임의 디렉터리에 적용. */
function listPublishedSlugsIn(dir) {
  const prev = process.env.PUBLISHED_DIR_OVERRIDE;
  process.env.PUBLISHED_DIR_OVERRIDE = dir;
  try { return listPublishedSlugs(); }
  finally {
    if (prev === undefined) delete process.env.PUBLISHED_DIR_OVERRIDE;
    else process.env.PUBLISHED_DIR_OVERRIDE = prev;
  }
}

// ── 노출 실측 ────────────────────────────────────────────────────────────────

/** 블로그 URL → slug. 글 URL 이 아니면(목록·태그·홈) null. */
export function slugFromUrl(url) {
  const m = String(url || '').match(/^https?:\/\/[^/]+\/blog\/([^/?#]+)\/?$/);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

/**
 * GSC page 차원에서 slug 별 노출을 합산한다.
 * 결손일(수집 안 된 날)을 함께 돌려준다 — "0회"와 "모름"을 구분해야 하기 때문이다.
 */
export function collectGscExposure(metrics) {
  const bySlug = new Map();
  const dates = [];
  const unmatched = new Set();
  for (const [, rec] of metrics) {
    if (rec.dimension !== 'page') continue;
    dates.push(rec.date);
    for (const row of rec.rows || []) {
      const slug = slugFromUrl(row.key);
      if (!slug) continue;                    // /blog·/blog?tag=·/ 등 목록 URL
      const cur = bySlug.get(slug) || { impressions: 0, clicks: 0, days: 0, positions: [], firstDate: null, lastDate: null };
      cur.impressions += row.impressions || 0;
      cur.clicks += row.clicks || 0;
      cur.days += 1;
      if (Number.isFinite(row.position)) cur.positions.push(row.position);
      if (!cur.firstDate || rec.date < cur.firstDate) cur.firstDate = rec.date;
      if (!cur.lastDate || rec.date > cur.lastDate) cur.lastDate = rec.date;
      bySlug.set(slug, cur);
    }
  }
  for (const [slug, v] of bySlug) {
    v.bestPosition = v.positions.length ? Math.min(...v.positions) : null;
    v.medianPosition = v.positions.length ? median(v.positions) : null;
    delete v.positions;
    if (!slug) unmatched.add(slug);
  }
  dates.sort();
  return { bySlug, coverage: coverageOf(dates) };
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 수집일 목록 → {first,last,collectedDays,missingDays[]}. 결손을 명시적으로 센다. */
export function coverageOf(dates) {
  if (!dates.length) return { first: null, last: null, collectedDays: 0, spanDays: 0, missingDays: [] };
  const uniq = [...new Set(dates)].sort();
  const first = uniq[0], last = uniq[uniq.length - 1];
  const have = new Set(uniq);
  const missing = [];
  for (let d = new Date(`${first}T00:00:00Z`); d <= new Date(`${last}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    const k = d.toISOString().slice(0, 10);
    if (!have.has(k)) missing.push(k);
  }
  return { first, last, collectedDays: uniq.length, spanDays: uniq.length + missing.length, missingDays: missing, dates: uniq };
}

/** 네이버 순위 — rank 가 null 이 아닌 행만 노출로 친다(null = display 상한 밖 = 모름). */
export function collectNaverExposure(text) {
  const bySlug = new Map();
  const dates = [];
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let rec;
    try { rec = JSON.parse(t); } catch { continue; }
    if (rec.date) dates.push(rec.date);
    for (const r of rec.ranks || []) {
      if (r.rank == null) continue;
      const slug = slugFromUrl(r.url);
      if (!slug) continue;
      const cur = bySlug.get(slug) || { bestRank: r.rank, hits: 0, queries: new Set(), lastDate: null };
      cur.bestRank = Math.min(cur.bestRank, r.rank);
      cur.hits += 1;
      if (rec.query) cur.queries.add(rec.query);
      if (!cur.lastDate || rec.date > cur.lastDate) cur.lastDate = rec.date;
      bySlug.set(slug, cur);
    }
  }
  for (const v of bySlug.values()) v.queries = [...v.queries];
  dates.sort();
  return { bySlug, coverage: coverageOf(dates) };
}

// ── 주제 유사도 ──────────────────────────────────────────────────────────────

/**
 * 제목·태그에서만 나오는 상투어. 본문이 아니라 **제목**을 보므로 목록이 짧다 —
 * "가이드·이유·방법"처럼 어느 글에나 붙는 말만 뺀다. 주제어(자동화·백테스트)는
 * 빼지 않는다. 흔한 주제어의 가중치는 idf 가 알아서 낮춘다.
 */
export const TITLE_STOPWORDS = new Set([
  '이유', '방법', '가이드', '정리', '비교', '차이', '실전', '실무', '기준', '경우', '사례', '결과',
  '것들', '무엇', '어디', '언제', '얼마', '한다', '하는', '했다', '있다', '없다', '된다', '되는',
  '위한', '위해', '통해', '대한', '보다', '까지', '부터', '그리고', '그러나', '하지만', '오히려',
  '진짜', '전부', '모두', '다시', '먼저', '아직', '이제', '지금', '바로', '가장', '더는', '못한',
  'vs', 'the', 'and', 'for', 'with', 'how', 'why', 'what', 'your', 'you', 'this', 'that',
]);

/**
 * 제목·태그 → 내용어 토큰. 조사 절단은 kernel/korean.stripJosa 를 쓴다(정본 재사용).
 * @param {string} text
 * @returns {string[]}
 */
export function topicTokens(text) {
  return collapse(text)
    .replace(/[()[\]{}<>《》「」『』"'“”‘’«»]/g, ' ')
    .replace(/[.,!?~·:;\-—–_/\\|+*=…%$#@&^]/g, ' ')
    .toLowerCase()
    .split(/\s+/).filter(Boolean)
    .map(stripJosa)
    .filter(w => w.length >= 2 && !TITLE_STOPWORDS.has(w));
}

/** 글 1편의 주제 문자열 — 제목 + 태그. 본문은 쓰지 않는다(주제가 아니라 문체를 닮으므로). */
export function topicText(post) {
  return `${post.title} ${(post.tags || []).join(' ')}`;
}

/** 코퍼스 문서빈도 — idf 가중치용. */
export function tokenDocFreq(texts) {
  const df = new Map();
  for (const t of texts) {
    for (const tok of new Set(topicTokens(t))) df.set(tok, (df.get(tok) || 0) + 1);
  }
  return { df, n: texts.length };
}

/** 흔한 낱말은 덜 세는 idf 가중 자카드. curiosity pick.mjs 의 topicSimilarity 와 같은 산출식. */
export function weightedJaccard(a, b, corpus = { df: new Map(), n: 0 }) {
  const A = new Set(topicTokens(a));
  const B = new Set(topicTokens(b));
  if (!A.size || !B.size) return 0;
  const n = Math.max(corpus.n, 30);          // 코퍼스가 작으면 희소도 추정이 뒤집힌다
  const weight = t => Math.log((n + 1) / ((corpus.df.get(t) || 0) + 0.5));
  let inter = 0, union = 0;
  for (const t of new Set([...A, ...B])) {
    const w = weight(t);
    union += w;
    if (A.has(t) && B.has(t)) inter += w;
  }
  return union > 0 ? inter / union : 0;
}

/** 공유 내용어 목록 — 유사도 점수만으로는 사람이 납득할 수 없어 근거로 같이 싣는다. */
export function sharedTokens(a, b) {
  const B = new Set(topicTokens(b));
  return [...new Set(topicTokens(a))].filter(t => B.has(t));
}

/** 문자 4-gram 자카드(kernel/minhash 의 charFourgrams 재사용). 표현이 대놓고 닮은 쌍용. */
export function wordingJaccard(a, b) {
  const A = charFourgrams(collapse(a).toLowerCase());
  const B = charFourgrams(collapse(b).toLowerCase());
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

/** 태그 자카드 — 태그는 사람이 붙인 주제 라벨이라 제목보다 신호가 곧다. */
export function tagJaccard(aTags, bTags) {
  const norm = t => collapse(t).toLowerCase().replace(/\s+/g, '');
  const A = new Set((aTags || []).map(norm).filter(Boolean));
  const B = new Set((bTags || []).map(norm).filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * 두 글의 주제 근접도. 세 신호를 각각 내고, 판정은 호출부가 임계로 한다.
 * 하나로 합치지 않는 이유: 사람이 리포트를 읽을 때 "왜 묶였나"를 신호별로 봐야 하기 때문이다.
 */
export function topicPair(a, b, corpus) {
  const ta = topicText(a), tb = topicText(b);
  return {
    topic:   round3(weightedJaccard(ta, tb, corpus)),
    wording: round3(wordingJaccard(a.title, b.title)),
    tags:    round3(tagJaccard(a.tags, b.tags)),
    shared:  sharedTokens(ta, tb),
  };
}

const round3 = n => Number(n.toFixed(3));

/** merge 관문 — 소재 관문 또는 표현 관문 중 하나만 걸려도 같은 소재로 본다. */
export function isSameTopic(pair, opts = DEFAULTS) {
  const byTopic = pair.topic >= opts.mergeTopic && pair.shared.length >= opts.minSharedTokens;
  const byWording = pair.wording >= opts.mergeWording;
  const byTags = pair.tags >= (opts.mergeTags ?? DEFAULTS.mergeTags) && pair.shared.length >= opts.minSharedTokens;
  if (!byTopic && !byWording && !byTags) return null;
  return byTopic ? 'topic' : byWording ? 'wording' : 'tags';
}

// ── 분류 ─────────────────────────────────────────────────────────────────────

/** ISO 날짜에 일수를 더한다(UTC 기준 — 날짜 문자열 산술이라 시간대 영향 없음). */
export function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * 유예 기준일 — 이 날짜보다 뒤에 나온 글은 "노출 0"을 사실로 취급하지 않는다.
 *
 * 두 조건을 **다** 만족해야 판단 자격이 생긴다.
 *   ① 발행 후 graceDays 일이 지났다 (색인이 붙을 시간)
 *   ② GSC 가 그 글을 graceDays **일 이상 실제로 수집했다** (측정된 날 수)
 *
 * ②를 달력이 아니라 수집일로 세는 이유: 이 저장소의 GSC 수집에는 결손이 있다
 * (2026-09-07 기준 66일 구간에 12일 결손, 그것도 8/17~9/1 에 몰려 있다).
 * 달력으로 14일을 세면 2026-08-21 발행글이 "관측 14일"로 보이지만 그중 9일은
 * 아예 수집되지 않았다 — 실제 측정은 5일뿐이다. 5일치로 "검색에 안 걸린다"고
 * 결론내고 글을 지우면 되돌릴 수 없다. **모르는 날은 0회가 아니다.**
 *
 * 두 기준일 중 **이른 쪽**을 택한다. 기준일이 이를수록 유예에 들어가는 글이 많아진다
 * (유예 조건이 `발행일 > 기준일` 이므로) — 즉 보수적인 쪽이다.
 *
 * @param {{today:string, gscDates?:string[], gscLast?:string|null, graceDays:number}} p
 * @returns {string|null} 이 날짜 **이하**로 발행된 글만 판단 대상.
 *   `null` 은 "0편"이 아니라 **아무도 판단할 자격이 없다**는 뜻이다 — 수집일 자체가
 *   graceDays 보다 적으면 어느 글도 graceDays 일 측정된 적이 없다.
 */
export function graceCutoff({ today, gscDates = null, gscLast = null, graceDays }) {
  const byToday = addDays(today, -graceDays);
  // 수집일 이력이 없으면(첫 실행·테스트) 달력만으로 본다.
  if (!gscDates || !gscDates.length) {
    const byLast = gscLast ? addDays(gscLast, -graceDays) : null;
    return byLast && byLast < byToday ? byLast : byToday;
  }
  const sorted = [...gscDates].sort();
  // 수집일이 graceDays 보다 적다 = 어느 글도 충분히 측정되지 않았다.
  // 여기서 가장 이른 수집일을 돌려주면 그보다 앞선 글이 "판단 완료"로 새어나간다.
  if (sorted.length < graceDays) return null;
  // 뒤에서 graceDays 번째 수집일 = "이 날짜에 발행됐다면 딱 graceDays 일 측정됐다".
  const byData = sorted[sorted.length - graceDays];
  return byData < byToday ? byData : byToday;
}

/** 니치 타겟팅 키워드 매칭 — improve 근거 ②. */
export function matchNiche(post, nicheKeywords, minWeight) {
  const hay = `${post.title} ${(post.tags || []).join(' ')}`.toLowerCase();
  return (nicheKeywords || [])
    .filter(k => (k.weight ?? 0) >= minWeight && k.keyword && hay.includes(String(k.keyword).toLowerCase()))
    .map(k => ({ keyword: k.keyword, weight: k.weight }));
}

/**
 * 전편을 keep / merge / improve / drop 후보로 나눈다.
 *
 * 우선순위(위가 이긴다):
 *   keep     — GSC 노출 이력 또는 네이버 순위 보유. 손대지 않는다.
 *   improve* — 유예 기간(색인·수집이 아직 안 끝남). drop 후보에서 구조적으로 뺀다.
 *   merge    — 같은 소재의 다른 글이 있다. 하나로 합칠 후보.
 *   improve  — 겹치지 않지만 ①노출된 글과 인접 소재이거나 ②현재 니치 타겟에 걸린다.
 *   drop     — 위 어디에도 안 걸린다.
 *
 * @returns {{keep:object[],merge:object[],improve:object[],drop:object[],clusters:object[]}}
 */
export function classify({ posts, gsc, naver, today, nicheKeywords = [], opts = DEFAULTS }) {
  const o = { ...DEFAULTS, ...opts };
  const cutoff = graceCutoff({
    today,
    gscDates: gsc.coverage?.dates || null,
    gscLast: gsc.coverage?.last || null,
    graceDays: o.graceDays,
  });
  const corpus = tokenDocFreq(posts.map(topicText));

  // ① 노출 여부 먼저 확정 — 이후 모든 판정이 여기에 기댄다.
  const exposure = new Map();
  for (const p of posts) {
    const g = gsc.bySlug.get(p.slug) || null;
    const n = naver.bySlug.get(p.slug) || null;
    exposure.set(p.slug, { gsc: g, naver: n, exposed: Boolean((g && g.impressions > 0) || (n && n.hits > 0)) });
  }

  // ② 쌍 유사도 — 노출 0 인 글에 대해서만 전편과 대조한다(노출된 글끼리 묶을 이유가 없다).
  const pairsBySlug = new Map();
  for (const p of posts) {
    if (exposure.get(p.slug).exposed) continue;
    const hits = [];
    for (const q of posts) {
      if (q.slug === p.slug) continue;
      const pair = topicPair(p, q, corpus);
      const same = isSameTopic(pair, o);
      if (same || pair.topic >= o.relatedTopic) {
        hits.push({ slug: q.slug, title: q.title, date: q.date, ...pair, same, exposed: exposure.get(q.slug).exposed });
      }
    }
    hits.sort((a, b) => b.topic - a.topic);
    pairsBySlug.set(p.slug, hits);
  }

  const out = { keep: [], merge: [], improve: [], drop: [] };
  const clusters = new Map();

  for (const p of posts) {
    const ex = exposure.get(p.slug);
    const base = { slug: p.slug, date: p.date, title: p.title, tags: p.tags };

    if (ex.exposed) {
      out.keep.push({
        ...base,
        evidence: {
          gsc_impressions: ex.gsc ? ex.gsc.impressions : 0,
          gsc_clicks: ex.gsc ? ex.gsc.clicks : 0,
          gsc_days_with_impressions: ex.gsc ? ex.gsc.days : 0,
          gsc_best_position: ex.gsc ? ex.gsc.bestPosition : null,
          naver_best_rank: ex.naver ? ex.naver.bestRank : null,
          naver_queries: ex.naver ? ex.naver.queries : [],
        },
        reason: ex.gsc && ex.gsc.impressions > 0
          ? `구글 노출 ${ex.gsc.impressions}회(${ex.gsc.days}일)${ex.naver ? ` + 네이버 최고 ${ex.naver.bestRank}위` : ''}`
          : `네이버 최고 ${ex.naver.bestRank}위 (구글 노출 0)`,
      });
      continue;
    }

    const hits = pairsBySlug.get(p.slug) || [];
    const sameHits = hits.filter(h => h.same);
    const relatedExposed = hits.filter(h => h.exposed && h.topic >= o.relatedTopic);
    const niche = matchNiche(p, nicheKeywords, o.nicheWeightMin);
    const ageDays = daysBetween(p.date, today);
    // 관측일 = 발행 후 GSC 가 **실제로 수집한** 날 수. 달력 일수가 아니다(결손일 때문).
    const observedDays = gsc.coverage?.dates ? gsc.coverage.dates.filter(d => d >= p.date).length : null;
    // 이 글이 살아 있던 기간 중 GSC 가 수집하지 못한 날. 그날의 노출은 0회가 아니라 **모른다**.
    const missingInWindow = gsc.coverage?.missingDays?.filter(d => d >= p.date).length ?? null;

    const common = {
      ...base,
      evidence: {
        gsc_impressions: 0,
        gsc_observed_days: observedDays,
        gsc_missing_days_in_window: missingInWindow,
        naver_best_rank: null,
        age_days: ageDays,
        similar_posts: sameHits.slice(0, 5).map(h => ({ slug: h.slug, topic: h.topic, wording: h.wording, tags: h.tags, shared: h.shared, matched_by: h.same, exposed: h.exposed })),
        related_exposed_posts: relatedExposed.slice(0, 3).map(h => ({ slug: h.slug, topic: h.topic, shared: h.shared, impressions: gsc.bySlug.get(h.slug)?.impressions ?? null })),
        niche_keywords: niche,
      },
    };

    // cutoff===null 은 "수집이 부족해 아무도 판단할 수 없다" 는 뜻 → 전원 유예.
    const inGrace = cutoff === null || p.date > cutoff;

    // merge 는 유예보다 먼저 본다. **중복이라는 사실은 노출 데이터에 기대지 않기 때문이다** —
    // 제목·태그만으로 성립하므로 색인이 아직 안 붙은 글에도 그대로 참이다. 게다가 merge 는
    // 삭제가 아니라 "같이 놓고 보라"는 제안이라, 유예 중이라고 숨기면 사람이 쌍을 놓친다.
    // 대신 grace_period 를 달아 "노출 0" 부분은 아직 못 믿는다는 걸 명시한다.
    if (sameHits.length) {
      const cid = clusterIdFor(clusters, p.slug, sameHits.map(h => h.slug));
      const best = sameHits[0];
      out.merge.push({
        ...common,
        cluster_id: cid,
        grace_period: inGrace,
        reason: `같은 소재 ${sameHits.length}편 (최근접 ${best.slug}, 소재유사 ${best.topic}, 공유어 ${best.shared.slice(0, 4).join('·') || '없음'})`
          + (best.exposed ? ' — 대상이 노출 보유글이라 흡수 권장' : '')
          + (inGrace
            ? ` · ⚠ 유예 중(GSC 실측 ${observedDays}일 < ${o.graceDays}일) — 중복 사실은 유효하나 노출 0 판단은 아직 이르다`
            : ` · 노출 0회(GSC 실측 ${observedDays}일)`),
      });
      continue;
    }

    // 유예 — 노출 0 을 사실로 취급할 자격이 아직 없다. drop 후보에서 구조적으로 뺀다.
    if (inGrace) {
      out.improve.push({
        ...common,
        grace_period: true,
        reason: `유예: ${p.date} 발행(${ageDays}일차), GSC 실측 ${observedDays ?? '?'}일 — 판단에 실측 ${o.graceDays}일 필요. drop 후보에서 제외.`,
      });
      continue;
    }

    if (relatedExposed.length || niche.length) {
      const bits = [];
      if (relatedExposed.length) bits.push(`노출 보유글과 인접 소재 ${relatedExposed.length}편(최근접 ${relatedExposed[0].slug}, ${relatedExposed[0].topic})`);
      if (niche.length) bits.push(`현재 니치 타겟 매칭 ${niche.map(k => `${k.keyword}(w${k.weight})`).join('·')}`);
      out.improve.push({
        ...common,
        grace_period: false,
        reason: `노출 0회(GSC 실측 ${observedDays}일) · ${bits.join(' · ')} — 주제는 살아 있고 글이 약하다`,
      });
      continue;
    }

    out.drop.push({
      ...common,
      // drop 은 되돌릴 수 없는 결정으로 이어지므로, 근거 문장에 **모르는 부분**까지 적는다.
      reason: `노출 0회(GSC 실측 ${observedDays}일, ${ageDays}일차`
        + (missingInWindow ? `, 미수집 ${missingInWindow}일은 판단에서 제외` : '')
        + `) · 같은 소재 없음 · 노출 보유글과 인접하지 않음 · 니치 타겟 미매칭`,
    });
  }

  // 클러스터에는 merge 로 안 간 멤버도 들어 있다 — 상대가 노출 보유글(keep)이거나
  // 아직 유예 중(improve)인 경우다. 사람이 "이 쌍 중 뭘 남길까"를 판단하려면 **쌍 전체**를
  // 봐야 하므로 멤버마다 어느 분류로 갔는지 표시한다. 이게 없으면 리포트에는 한쪽만 보인다.
  const bucketOf = new Map();
  for (const b of ['keep', 'merge', 'improve', 'drop']) {
    for (const x of out[b]) bucketOf.set(x.slug, b === 'improve' && x.grace_period ? 'improve(유예)' : b);
  }
  const byPost = new Map(posts.map(p => [p.slug, p]));
  const enriched = [...clusters.values()].map(c => ({
    ...c,
    members: c.members.map(slug => ({
      slug,
      bucket: bucketOf.get(slug) || 'unknown',
      date: byPost.get(slug)?.date ?? null,
      title: byPost.get(slug)?.title ?? null,
      gsc_impressions: gsc.bySlug.get(slug)?.impressions ?? 0,
    })),
  }));

  return { ...out, clusters: enriched, cutoff, corpusSize: corpus.n };
}

function daysBetween(fromIso, toIso) {
  return Math.round((new Date(`${toIso}T00:00:00Z`) - new Date(`${fromIso}T00:00:00Z`)) / 86400000);
}

/** 같은 소재 쌍을 연결요소(union-find 대용)로 묶어 클러스터 id 를 부여. */
function clusterIdFor(clusters, slug, others) {
  const all = [slug, ...others];
  let found = null;
  for (const [id, c] of clusters) {
    if (all.some(s => c.members.includes(s))) { found = id; break; }
  }
  if (found == null) {
    const id = `c${clusters.size + 1}`;
    clusters.set(id, { id, members: [...new Set(all)] });
    return id;
  }
  const c = clusters.get(found);
  c.members = [...new Set([...c.members, ...all])];
  return found;
}

// ── 리포트 ───────────────────────────────────────────────────────────────────

/** 사람이 읽고 승인/거부할 수 있는 형태. 분류가 자동으로 정답일 수 없기 때문에 근거를 다 싣는다. */
export function renderReport(result) {
  const { meta, keep, merge, improve, drop } = result;
  const L = [];
  L.push('# 노출 0 발행글 정리 후보');
  L.push('');
  L.push(`생성 ${meta.generated_at} · 기준일 ${meta.today} · 발행물 ${meta.published_total}편`);
  L.push('');
  L.push('> 🔴 **이 문서는 제안이다. 스크립트는 아무것도 지우지 않는다.** 각 항목의 근거를 읽고 사람이 결정한다.');
  L.push('');
  L.push('## 요약');
  L.push('');
  L.push('| 분류 | 편수 | 뜻 |');
  L.push('|---|---:|---|');
  L.push(`| keep | ${keep.length} | 검색 노출 이력 있음 — 손대지 않는다 |`);
  L.push(`| merge | ${merge.length} | 같은 소재의 다른 글이 있다 — 하나로 합칠 후보(유예 중 ${merge.filter(x => x.grace_period).length}편 포함) |`);
  L.push(`| improve | ${improve.length} | 살릴 값어치 있음(유예 ${improve.filter(x => x.grace_period).length}편 포함) |`);
  L.push(`| drop | ${drop.length} | 위 어디에도 안 걸림 — 사람 판단 필요 |`);
  L.push('');
  L.push('## 계측 한계 (읽기 전에)');
  L.push('');
  L.push(`- GSC page 수집: ${meta.gsc.first} ~ ${meta.gsc.last}, ${meta.gsc.collected_days}일 수집 / ${meta.gsc.missing_days.length}일 **결손**.`);
  L.push(`  결손일의 노출은 0회가 아니라 **모른다**. 결손일: ${meta.gsc.missing_days.join(', ') || '없음'}`);
  L.push(`- GSC query 차원은 ${meta.gsc.query_last ?? '미수집'} 이후 끊겨 있다 — 쿼리 기반 판단은 하지 않았다.`);
  L.push(`- 네이버 순위 수집분 중 우리 URL 이 잡힌 글은 ${meta.naver.slugs_with_rank}편뿐이다(나머지는 display 상한 30 밖 = 모름).`);
  L.push(`- GSC 에는 나오는데 \`published/\` 에 없는 slug ${meta.gsc.slugs_not_in_published.length}건: ${meta.gsc.slugs_not_in_published.join(', ') || '없음'}`);
  L.push(`  (\`published/\` 는 아카이브이고 실제 렌더는 \`content/blog\` 이라 갈릴 수 있다 — 이 스크립트는 \`published/\` 만 본다.)`);
  L.push(meta.grace.cutoff === null
    ? `- ⚠ **유예 기준일 없음** — GSC 수집일이 ${meta.grace.days}일보다 적어 어느 글도 판단할 자격이 없다. drop 은 비어 있어야 정상이다.`
    : `- 유예 기준일 **${meta.grace.cutoff}** 이후 발행글은 drop 후보에서 뺐다: ${meta.grace.reason}`);
  L.push(`  달력이 아니라 **실제 수집된 날 수**로 센다 — 결손이 8/17~9/1 에 몰려 있어 달력으로 세면 5일치 데이터로 삭제 판단을 내리게 된다.`);
  L.push('');
  L.push('## 판정 규칙');
  L.push('');
  L.push('| 임계 | 값 | 뜻 |');
  L.push('|---|---:|---|');
  L.push(`| merge_topic | ${meta.thresholds.mergeTopic} | 내용어 idf 가중 유사도 — 이 이상이고 공유 내용어 ${meta.thresholds.minSharedTokens}개 이상이면 같은 소재 |`);
  L.push(`| merge_wording | ${meta.thresholds.mergeWording} | 제목 문자 4-gram 자카드 — 표현이 대놓고 닮은 쌍 |`);
  L.push(`| merge_tags | ${meta.thresholds.mergeTags} | 태그 자카드 — 사람이 붙인 주제 라벨이 거의 같은 쌍 |`);
  L.push(`| related_topic | ${meta.thresholds.relatedTopic} | 이 이상이면 인접 소재(improve 근거 ①) |`);
  L.push(`| grace_days | ${meta.thresholds.graceDays} | 색인·수집 유예 |`);
  L.push('');

  const table = (rows, extra) => {
    const out = ['| slug | 발행 | 제목 | 근거 |', '|---|---|---|---|'];
    for (const r of rows) out.push(`| \`${r.slug}\` | ${r.date} | ${escapePipe(r.title)} | ${escapePipe(r.reason)} |`);
    if (extra) out.push(...extra);
    return out;
  };

  L.push(`## merge — ${merge.length}편`);
  L.push('');
  if (!merge.length) L.push('_없음_');
  else {
    const byCluster = new Map();
    for (const m of merge) {
      if (!byCluster.has(m.cluster_id)) byCluster.set(m.cluster_id, []);
      byCluster.get(m.cluster_id).push(m);
    }
    const clusterById = new Map((result.clusters || []).map(c => [c.id, c]));
    for (const [cid, members] of [...byCluster].sort((a, b) => b[1].length - a[1].length)) {
      const cluster = clusterById.get(cid);
      L.push(`### ${cid} — 같은 소재 ${cluster ? cluster.members.length : members.length}편 (그중 merge 후보 ${members.length}편)`);
      L.push('');
      if (cluster) {
        // 쌍의 한쪽이 keep(노출 보유)이거나 유예 중이면 merge 표에는 안 나온다.
        // 그쪽을 안 보여주면 "합칠 대상이 없는 외톨이"로 오독된다.
        L.push('| 클러스터 멤버 | 분류 | 발행 | 구글 노출 |');
        L.push('|---|---|---|---:|');
        for (const m of cluster.members) {
          L.push(`| \`${m.slug}\` | ${m.bucket} | ${m.date ?? '?'} | ${m.gsc_impressions} |`);
        }
        L.push('');
      }
      L.push(...table(members));
      L.push('');
    }
  }
  L.push('');
  L.push(`## improve — ${improve.length}편`);
  L.push('');
  L.push(...table(improve.filter(x => !x.grace_period)));
  L.push('');
  L.push(`### 유예(최근 발행) — ${improve.filter(x => x.grace_period).length}편`);
  L.push('');
  L.push(...table(improve.filter(x => x.grace_period)));
  L.push('');
  L.push(`## drop 후보 — ${drop.length}편`);
  L.push('');
  L.push('⚠ **삭제 지시가 아니다.** 노출 0이고 대체·인접 근거가 없다는 사실의 목록이다.');
  L.push('');
  L.push(...table(drop));
  L.push('');
  L.push(`## keep — ${keep.length}편`);
  L.push('');
  L.push(...table([...keep].sort((a, b) => (b.evidence.gsc_impressions || 0) - (a.evidence.gsc_impressions || 0))));
  L.push('');
  return L.join('\n');
}

const escapePipe = s => String(s ?? '').replace(/\|/g, '\\|');

// ── 실행 ─────────────────────────────────────────────────────────────────────

/** 오늘 날짜(KST). 커널 규약대로 시계는 주입 가능하게 둔다. */
function todayKst(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

export function buildResult({ paths = DEFAULTS, today = todayKst(), opts = DEFAULTS } = {}) {
  const posts = loadPosts(paths.publishedDir);
  const metrics = loadSeoMetrics(paths.metricsPath);
  const gsc = collectGscExposure(metrics);
  const naver = collectNaverExposure(existsSync(paths.naverPath) ? readFileSync(paths.naverPath, 'utf8') : '');

  let nicheKeywords = [];
  try {
    nicheKeywords = JSON.parse(readFileSync(paths.configPath, 'utf8'))?.topic_targeting?.niche_keywords || [];
  } catch { /* 설정 없으면 improve 근거 ② 만 빠진다 — 치명적이지 않다 */ }

  const known = new Set(posts.map(p => p.slug));
  const notInPublished = [...gsc.bySlug.keys()].filter(s => !known.has(s));

  // query 차원 마지막 수집일 — 리포트의 계측 한계 항목용.
  let queryLast = null;
  for (const [k] of metrics) {
    const [d, dim] = k.split('|');
    if (dim === 'query' && (!queryLast || d > queryLast)) queryLast = d;
  }

  const cls = classify({ posts, gsc, naver, today, nicheKeywords, opts });

  return {
    generated_at: new Date().toISOString(),
    today,
    meta: {
      generated_at: new Date().toISOString(),
      today,
      published_total: posts.length,
      thresholds: {
        mergeTopic: opts.mergeTopic ?? DEFAULTS.mergeTopic,
        mergeWording: opts.mergeWording ?? DEFAULTS.mergeWording,
        mergeTags: opts.mergeTags ?? DEFAULTS.mergeTags,
        relatedTopic: opts.relatedTopic ?? DEFAULTS.relatedTopic,
        minSharedTokens: opts.minSharedTokens ?? DEFAULTS.minSharedTokens,
        nicheWeightMin: opts.nicheWeightMin ?? DEFAULTS.nicheWeightMin,
        graceDays: opts.graceDays ?? DEFAULTS.graceDays,
      },
      gsc: {
        first: gsc.coverage.first,
        last: gsc.coverage.last,
        collected_days: gsc.coverage.collectedDays,
        missing_days: gsc.coverage.missingDays,
        query_last: queryLast,
        blog_slugs_with_impressions: gsc.bySlug.size,
        slugs_not_in_published: notInPublished,
      },
      naver: {
        first: naver.coverage.first,
        last: naver.coverage.last,
        collected_days: naver.coverage.collectedDays,
        slugs_with_rank: naver.bySlug.size,
      },
      grace: {
        days: opts.graceDays ?? DEFAULTS.graceDays,
        cutoff: cls.cutoff,
        reason: `발행 후 ${opts.graceDays ?? DEFAULTS.graceDays}일 미만이거나, GSC 가 **실제로 수집한** 날이 ${opts.graceDays ?? DEFAULTS.graceDays}일 미만인 글 (수집 결손일은 노출 0회가 아니라 미측정으로 친다)`,
      },
      counts: { keep: cls.keep.length, merge: cls.merge.length, improve: cls.improve.length, drop: cls.drop.length },
      note: '제안 전용. 이 산출물은 어떤 파일도 지우지 않으며 삭제·병합은 사람이 승인한다.',
    },
    keep: cls.keep,
    merge: cls.merge,
    improve: cls.improve,
    drop: cls.drop,
    clusters: cls.clusters,
  };
}

/** --calibrate: 임계를 눈으로 고를 수 있게 쌍 유사도 분포를 덤프한다. */
function calibrate() {
  const posts = loadPosts();
  const corpus = tokenDocFreq(posts.map(topicText));
  const pairs = [];
  for (let i = 0; i < posts.length; i++) {
    for (let j = i + 1; j < posts.length; j++) {
      const p = topicPair(posts[i], posts[j], corpus);
      pairs.push({ a: posts[i].slug, b: posts[j].slug, ...p });
    }
  }
  pairs.sort((x, y) => y.topic - x.topic);
  const qs = [0.5, 0.9, 0.99, 0.999, 0.9999];
  const sorted = pairs.map(p => p.topic).sort((a, b) => a - b);
  process.stdout.write(`pairs=${pairs.length}\n`);
  for (const q of qs) process.stdout.write(`topic p${q * 100}=${sorted[Math.floor(sorted.length * q)].toFixed(3)}\n`);
  for (const p of pairs.slice(0, 60)) {
    process.stdout.write(`${p.topic}\t${p.wording}\t${p.tags}\t${p.shared.slice(0, 5).join(',')}\t${p.a}  ||  ${p.b}\n`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--calibrate')) { calibrate(); return 0; }
  const dryRun = argv.includes('--dry-run');

  const result = buildResult();
  const report = renderReport(result);

  if (!dryRun) {
    mkdirSync(dirname(DEFAULTS.outJson), { recursive: true });
    writeFileSync(DEFAULTS.outJson, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    mkdirSync(dirname(DEFAULTS.outReport), { recursive: true });
    writeFileSync(DEFAULTS.outReport, report, 'utf8');
  }

  const c = result.meta.counts;
  log.info(`발행 ${result.meta.published_total}편 → keep ${c.keep} / merge ${c.merge} / improve ${c.improve} / drop ${c.drop}` + (dryRun ? ' (dry-run)' : ''));
  log.info(`GSC 결손일 ${result.meta.gsc.missing_days.length}일 · 유예 기준일 ${result.meta.grace.cutoff}`);
  if (!dryRun) log.info(`산출: ${DEFAULTS.outJson} · ${DEFAULTS.outReport}`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  try { process.exit(main()); }
  catch (e) { log.error(e?.stack || String(e)); process.exit(2); }
}
