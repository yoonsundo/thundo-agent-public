#!/usr/bin/env node
/**
 * cardnews/pick.mjs — Deer 🦌 best-pick (계획 §3.4, AC-3)
 *
 * 사용: node scripts/cardnews/pick.mjs
 * 계약: stdout JSON `{ok, pick|null, score, breakdown, reason}`. exit 0 / 2=오류
 *
 * 미소비 백로그를 구독 claude 로 배치 1콜 채점(resonance·savability·clarity)하고, freshness 는
 * 로컬 계산 → 가중합 최고 1건. 하루 1건이므로 이 관문이 곧 그날의 채널이다.
 *
 * 🔴 **버티컬 전환(2026-07-31)**: 채점 축이 surprise → **resonance** 로 갈렸다. 세계 문화는
 * "어? 거기선 그래?"가 통화였지만, 위로 채널의 통화는 "이건 내 얘기다"다. 놀라움을 재는
 * 축을 그대로 두면 채점자가 계속 신기한 것을 위로보다 위에 놓는다.
 */
import { mkdirSync, appendFileSync } from 'node:fs';
import { makeLogger } from '../lib/log.mjs';
import {
  loadConfig, loadBacklog, loadIndex, callClaude, extractJson, isMainModule, withBrief,
  stateRoot, pickScoresPath, kstDate,
} from './lib.mjs';
import { hasQuoteSource } from './backlog.mjs';
import '../lib/force-subscription.mjs';

const log = makeLogger('cardnews/pick');

// ── 소비 여부 ────────────────────────────────────────────────────────────────

/**
 * 아직 소비되지 않은 백로그 항목.
 *
 * 인덱스는 post_id 로 키가 잡히고 각 post 가 `backlog_id` 를 들고 있으므로, 소비된 소재는
 * 그 역인덱스로 판정한다. **held 도 소비로 본다** — held 된 소재를 다시 pick 하면 매일 같은
 * 것이 최고점으로 올라와 슬롯을 독점한다. transient held 의 회복은 pick 이 아니라 sweep 이
 * 이어받는 경로다.
 */
export function consumedBacklogIds(index = loadIndex()) {
  const ids = new Set();
  for (const post of Object.values(index || {})) {
    if (post && post.backlog_id) ids.add(post.backlog_id);
  }
  return ids;
}

export function pendingBacklog({ backlog = null, index = null } = {}) {
  const items = backlog || loadBacklog();
  const consumed = consumedBacklogIds(index || loadIndex());
  return items.filter(it => it && it.id && !consumed.has(it.id));
}

// ── freshness ────────────────────────────────────────────────────────────────

/** 최근 사용 순 감점 계수 — 가장 최근이 가장 세다. */
const RECENCY_PENALTY = [0.4, 0.6, 0.8];

/**
 * 최근 발행 이력 → `freshOf(item)`.
 *
 * 🔴 회전축은 **`problem`(문제 유형)** 이다. 같은 고민이 연달아 나오면 계정이 한 자리에 갇힌다.
 *
 * 🔴 **책은 회전시키지 않는다**(2026-07-31 사용자 결정). 옛 버티컬에는 "최근 N건이 전부 같은
 * 나라면 감점"하는 백스톱이 있었지만, 이 채널에서 같은 책이 여러 번 나오는 것은 결함이 아니라
 * **정체성**이다 — 한 작가를 계속 읽는 계정은 팔로우할 이유가 된다. 그래서 백스톱을 통째로
 * 들어냈다(그 코드는 `pick.mjs.worldculture.bak` 에 있다).
 *
 * 옛 재고에는 `problem` 이 없다 → 그 항목만 `trigger_situation`·`domain` 으로 폴백한다
 * (회전축이 통째로 잠들지 않게). 신규 수집분은 `problem` 이 필수라 폴백을 타지 않는다.
 */
export function freshnessMap(index = {}, backlog = []) {
  const byId = new Map(backlog.map(b => [b.id, b]));
  const recentProblems = Object.values(index || {})
    .filter(p => p && p.published_at)
    .sort((a, b) => (a.published_at < b.published_at ? 1 : -1))
    .map((p) => {
      const b = byId.get(p.backlog_id);
      return rotationKey({
        problem: p.problem || b?.problem,
        trigger_situation: p.trigger_situation || b?.trigger_situation,
        domain: p.domain || b?.domain,
      });
    })
    .filter(Boolean)
    .slice(0, 3);

  return (item) => {
    const key = rotationKey(item);
    const i = key ? recentProblems.indexOf(key) : -1;
    return i === -1 ? 1.0 : RECENCY_PENALTY[i];
  };
}

/**
 * 회전 키 — `problem` 우선, 없으면 옛 재고용 폴백(`trigger_situation` → `domain`).
 * 정규화(공백 접기·소문자)만 한다: 문제 문구는 자유서술이라 표기 흔들림("내가 너무 많이 준 것
 * 같을 때" / "내가 너무  많이 준 것 같을때")이 같은 축을 다른 축으로 갈라놓기 쉽다.
 */
export function rotationKey(item) {
  const raw = String(item?.problem || '').trim()
    || String(item?.trigger_situation || '').trim()
    || String(item?.domain || '').trim();
  return raw ? raw.replace(/\s+/g, ' ').toLowerCase() : null;
}

// ── 유사 재탕 차단 ───────────────────────────────────────────────────────────

/** 유사도 비교용 조사·어미 목록(긴 것 먼저 — 최장일치). */
const JOSA = ['에서는', '으로는', '이라는', '에게서', '라는', '에서', '으로', '에게', '까지', '부터', '보다', '처럼', '만큼', '이나', '와의', '과의', '한테',
  '은', '는', '이', '가', '을', '를', '의', '에', '와', '과', '도', '만', '로', '랑'];

/** 어절 끝 조사 1개 절단(어간 2자 이상 보존). */
export function stripJosa(word) {
  const w = String(word || '');
  if (w.length < 3) return w;
  for (const p of JOSA) {
    if (w.endsWith(p) && w.length - p.length >= 2) return w.slice(0, -p.length);
  }
  return w;
}

/** 주제 정규화 — 괄호·문장부호 제거 + 어절별 조사 절단 후 이어붙임. */
export function normalizeSubject(s) {
  return String(s || '')
    .replace(/[()[\]{}<>《》「」『』"'“”‘’«»]/g, ' ')
    .replace(/[.,!?~·:;\-—–_/\\|+*=…%$#@&^]/g, ' ')
    .toLowerCase()
    .split(/\s+/).filter(Boolean)
    .map(stripJosa)
    .join('');
}

function charBigrams(s) {
  const set = new Set();
  for (let i = 0; i + 1 < s.length; i++) set.add(s.slice(i, i + 2));
  return set;
}

/** 두 주제의 정규화 유사도 → `{jaccard, contained}`. */
export function subjectSimilarity(a, b, { min_chars = 6 } = {}) {
  const na = normalizeSubject(a), nb = normalizeSubject(b);
  if (!na || !nb) return { jaccard: 0, contained: false };
  const contained = na.length >= min_chars && nb.length >= min_chars && (na.includes(nb) || nb.includes(na));
  const A = charBigrams(na), B = charBigrams(nb);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  const union = A.size + B.size - inter;
  return { jaccard: union ? inter / union : 0, contained };
}

/** 후보가 기존 주제들과 사실상 같은 소재인가. sha1 완전일치 dedup 이 못 잡는 재탕을 잡는다. */
export function isNearDuplicate(subject, existing = [], opts = {}) {
  const threshold = opts.bigram_jaccard ?? 0.45;
  const useSubstring = opts.substring !== false;
  let worst = { dup: false, jaccard: 0, against: null };
  for (const other of existing) {
    if (!other) continue;
    const { jaccard, contained } = subjectSimilarity(subject, other, opts);
    if ((useSubstring && contained) || jaccard >= threshold) {
      return { dup: true, jaccard: Number(jaccard.toFixed(3)), contained, against: other };
    }
    if (jaccard > worst.jaccard) worst = { dup: false, jaccard: Number(jaccard.toFixed(3)), against: other };
  }
  return worst;
}

/** 소재의 제목 자리 — 이 채널에서는 `problem` 이고, 엔진 호환 미러가 `subject` 다. */
export const titleOf = (item) => String(item?.problem || item?.subject || '').trim();

/** 이미 소비된 문제 목록 — 인덱스에 문구가 없는 구항목은 백로그에서 보강. */
export function doneSubjects(index = {}, backlog = []) {
  const byId = new Map(backlog.map(b => [b.id, b]));
  return Object.values(index || {})
    .map(p => titleOf(p) || titleOf(byId.get(p?.backlog_id)))
    .filter(Boolean);
}

// ── 채점 ─────────────────────────────────────────────────────────────────────

export function buildScorePrompt(items) {
  // 인용·해설·전환을 함께 싣는다 — 이게 빠지면 resonance·savability 를 판정할 근거가 후보에
  // 없고, 채점자는 결국 problem 의 어감만 보고 점수를 매긴다.
  const list = items.map(it => `{"id":"${it.id}","problem":${JSON.stringify(titleOf(it))},"situation":${JSON.stringify(it.situation || '')},"quote_ko":${JSON.stringify(it.quote_ko || '')},"source":${JSON.stringify(`${it.source?.title || ''} · ${it.source?.author || ''}`)},"form":${JSON.stringify(it.form || '')},"interpretation":${JSON.stringify(it.interpretation || '')},"shift":${JSON.stringify(it.shift || '')},"audience":${JSON.stringify(it.audience || '')}}`).join('\n');
  return withBrief('deer', `각 카드뉴스 소재 후보를 세 축으로 0.0~1.0 채점하라.

- resonance: 읽던 사람이 "이건 내 얘기다" 하고 **멈추는가**(problem·situation 이 구체적이고 흔한 경험일수록 높게).
- savability: 다시 꺼내 볼 값어치가 있는가(그 상황이 또 올 때 찾아볼 문장인가, 남에게 보낼 이유가 있는가).
- clarity: 카드 7장(헤드라인 24자·본문 90자)에 군더더기 없이 담기는가(줄거리를 알아야 이해되는 구절은 낮게).

⚠ **인용 날조·사람 일반화·치료 조언 금지, 원문에서 확인된 문장만.** 후보가 **성별·연령·유형(MBTI 등)으로 사람을 묶거나** **진단·치료·처방으로 읽히는 조언을 하거나** **위기 상황을 부추기면** 세 축 모두 0.2 이하로 주어라. 차단 사유는 이 셋뿐이다 — 슬프거나 세거나 불편하다는 이유로 깎지 마라. 마음이 지친 사람이 보는 계정에서 아무 말도 하지 않는 안전함은 안전이 아니다.

⚠ **뻔한 위로를 통과시키는 것도 실패다.** 어디서나 볼 수 있는 문구, 이미 밈이 된 구절, "결국 다 지나간다" 류의 무해한 총론은 resonance 0.3 이하로 주어라. 안전한 쪽으로만 힘이 걸리면 채널은 아무도 저장하지 않는 무난한 문장 모음으로 수렴한다.

ℹ 같은 책이 여러 번 나오는 것은 **감점 사유가 아니다**(그건 이 채널의 정체성이다). 회전은 기계가 문제 유형으로 따로 처리한다.

[후보]
${list}

[출력] JSON 배열만: [{ "id":"...", "resonance":0.0, "savability":0.0, "clarity":0.0 }]. 설명 없이.`);
}

/**
 * 후보 전원을 total 내림차순으로 정렬. claude 배치 채점 결과(scores)를 받아 여기서만
 * 가중합을 계산한다 — 가중치 산수를 한 곳에 모아야 스코어 해석이 갈리지 않는다.
 */
export function scoreAll({ items, scores = [], freshOf, weights }) {
  const w = weights || { resonance: 0.35, savability: 0.30, clarity: 0.20, freshness: 0.15 };
  const byId = new Map(scores.map(s => [s.id, s]));
  const fresh = freshOf || (() => 1.0);
  return items.map(it => {
    // 미채점 후보를 0 으로 두면 응답이 일부 빠졌을 때 그 후보가 영구 탈락한다 → 중립 0.5.
    const s = byId.get(it.id) || {};
    const resonance = Number.isFinite(s.resonance) ? s.resonance : 0.5;
    const savability = Number.isFinite(s.savability) ? s.savability : 0.5;
    const clarity = Number.isFinite(s.clarity) ? s.clarity : 0.5;
    const freshness = fresh(it);
    const scored = Number.isFinite(s.resonance) || Number.isFinite(s.savability) || Number.isFinite(s.clarity);
    const total = resonance * (w.resonance || 0)
      + savability * (w.savability || 0)
      + clarity * (w.clarity || 0)
      + freshness * (w.freshness || 0);
    return { item: it, total, resonance, savability, clarity, freshness, scored };
  }).sort((a, b) => b.total - a.total);
}

// ── 채점 분포 로그 ───────────────────────────────────────────────────────────

/** 클램프 발화 판정 — 세 축이 **모두** 0.2 이하면 프롬프트의 차단 조항이 걸린 것으로 본다. */
export const isClamped = (s) => s.scored && s.resonance <= 0.2 && s.savability <= 0.2 && s.clarity <= 0.2;
/** 뻔함 판정 — counter-pressure("뻔한 위로는 resonance ≤0.3")의 발화. */
export const isObvious = (s) => s.scored && s.resonance <= 0.3;

const stat = (xs) => (xs.length
  ? { min: Number(Math.min(...xs).toFixed(3)), max: Number(Math.max(...xs).toFixed(3)), mean: Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3)) }
  : { min: null, max: null, mean: null });

/**
 * 채점 분포 요약 — **클램프가 얼마나 자주 발화하는지 아무도 모른다**는 것이 이 로그의 이유다.
 * 차단 조항은 정규식 게이트보다 **앞**에 있는 LLM 재량이라, 넓게 걸리면 좋은 소재가 게이트에
 * 닿기도 전에 죽는데 그 사실이 어디에도 남지 않았다. 이전 버티컬에서 모호어("웃음거리")를 쓴
 * 클램프가 멀쩡한 소재까지 죽인 것이 실측됐고, 그래서 이 채널의 클램프는 셋으로 좁고
 * 그 발화율이 파일로 남는다.
 */
export function summarizeScores(sorted = [], { now = new Date(), reason = 'ok' } = {}) {
  const scored = sorted.filter(s => s.scored);
  const clamped = sorted.filter(isClamped);
  const obvious = sorted.filter(isObvious);
  const best = sorted[0] || null;
  return {
    at: now.toISOString(),
    date: kstDate(now),
    reason,
    candidates: sorted.length,
    scored: scored.length,
    unscored: sorted.length - scored.length,
    clamped: clamped.length,
    clamped_ids: clamped.map(s => s.item.id),
    obvious: obvious.length,
    with_quote: sorted.filter(s => hasQuoteSource(s.item)).length,
    resonance: stat(scored.map(s => s.resonance)),
    savability: stat(scored.map(s => s.savability)),
    clarity: stat(scored.map(s => s.clarity)),
    freshness: stat(sorted.map(s => s.freshness)),
    picked: best ? { id: best.item.id, total: Number(best.total.toFixed(4)), resonance: best.resonance, freshness: best.freshness } : null,
  };
}

/** 요약 1줄 append. 실패는 비차단(`appendRun` 과 같은 정책 — 관측이 발행을 죽이지 않는다). */
export function appendScoreLog(row) {
  try {
    mkdirSync(stateRoot(), { recursive: true });
    appendFileSync(pickScoresPath(), JSON.stringify(row) + '\n', 'utf8');
  } catch (e) {
    log.warn(`pick-scores.jsonl 기록 실패(비차단): ${e.message}`);
  }
  return row;
}

/**
 * 오늘의 1건. 후보 0건이면 `{pick:null, reason}` 으로 **정상 종료**한다 — 소재 고갈은 오류가
 * 아니라 상태이고, 오케가 `no-pick` 으로 기록해야 할 사건이다.
 */
export function pick({ cfg = null, deps = {}, logScores = true } = {}) {
  const conf = cfg || loadConfig();
  const call = deps.callClaude || callClaude;
  const backlog = loadBacklog();
  const index = loadIndex();

  let items = pendingBacklog({ backlog, index });
  if (!items.length) return { ok: true, pick: null, score: 0, breakdown: [], reason: 'no-candidates' };

  // 채점 **전에** 유사 재탕을 걷어낸다 — 토큰도 아끼고, 걸러낼 것을 채점하지도 않는다.
  const simCfg = conf.pick?.similarity || {};
  if (simCfg.enabled !== false) {
    const done = doneSubjects(index, backlog);
    const before = items.length;
    items = items.filter(it => !isNearDuplicate(titleOf(it), done, simCfg).dup);
    if (before !== items.length) log.info(`유사 재탕 제외: ${before - items.length}건`);
    if (!items.length) return { ok: true, pick: null, score: 0, breakdown: [], reason: 'all-near-duplicate' };
  }

  let scores = [];
  try {
    scores = extractJson(call(buildScorePrompt(items), { cfg: conf }));
    if (!Array.isArray(scores)) scores = [];
  } catch (e) {
    // 채점 실패는 치명적이지 않다 — 전원 중립 0.5 + freshness 로만 순위가 갈린다.
    // 여기서 던지면 소재 재고가 40건 있어도 그날이 결방이 된다.
    if (e.budget) throw e;               // 예산 초과는 던진다(폭주 방지가 목적이므로)
    log.warn(`채점 실패 → freshness 만으로 선정(비차단): ${e.message}`);
  }

  const freshOf = freshnessMap(index, backlog);
  const sorted = scoreAll({ items, scores, freshOf, weights: conf.pick?.weights });
  const best = sorted[0];
  const distribution = summarizeScores(sorted);
  if (logScores) appendScoreLog(distribution);
  log.info(`선정: ${sorted.length}건 채점 · 클램프 ${distribution.clamped}건 · 뻔함(resonance≤0.3) ${distribution.obvious}건`);
  return {
    ok: true,
    pick: best.item,
    score: Number(best.total.toFixed(4)),
    breakdown: sorted.slice(0, 5).map(s => ({
      id: s.item.id,
      problem: titleOf(s.item),
      subject: titleOf(s.item),
      book: s.item.source?.title ?? null,
      author: s.item.source?.author ?? null,
      total: Number(s.total.toFixed(4)),
      resonance: s.resonance, savability: s.savability, clarity: s.clarity, freshness: s.freshness,
    })),
    distribution,
    reason: 'ok',
  };
}

function main() {
  try {
    const r = pick();
    process.stdout.write(JSON.stringify(r) + '\n');
    process.exit(0);
  } catch (e) {
    log.error(`선정 실패: ${e.message}`);
    process.stdout.write(JSON.stringify({ ok: false, error: e.message, diag: e.diag || null }) + '\n');
    process.exit(2);
  }
}

if (isMainModule(import.meta.url)) main();
