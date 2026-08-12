#!/usr/bin/env node
/**
 * shorts-curiosity/pick.mjs — 백로그 best-pick (반전·호기심 강도 점수)
 *
 * 사용: node scripts/shorts-curiosity/pick.mjs
 *
 * 미제작 백로그 항목을 구독 claude 로 surprise(반전강도)·scrollstop(호기심) 채점(배치 1콜),
 * freshness(최근 사용 도메인 감점)는 로컬 계산 → 가중합 최고 1건 선정.
 * 계약: stdout JSON {ok, pick|null, score, reason}. exit 0 / 2=오류
 *
 * US-003 콘텐츠 룰(2026-07-29 실측 대응) — 채점 **전에** 후보를 걸러 토큰도 아낀다.
 *  ① whatif 일일 상한: 하루 제작분에서 '만약 ~라면?'(whatif) 비율이 config
 *     backlog.angles.whatif_ratio 를 넘지 않게 강제(3편/일·0.35 → 최대 1편). 07-28 3/3편이
 *     whatif 로 나가 포맷 3연속 반복 → 스와이프 이탈. 상한에 걸리면 reveal 후보로 채운다
 *     (⚠ ratio>0의 일일 상한은 편수를 줄이지 않는다. ratio=0은 성과 대응 하드 중지라 완화하지 않는다).
 *  ② 유사주제 중복 차단: subject sha1 완전일치 dedup 은 문구만 바뀐 재탕을 못 잡는다
 *     (07-27 "…쐈던 배우" ↔ 07-29 "…쐈던 배우 (공포탄의 진실)"). 정규화 후 문자 bigram
 *     Jaccard 또는 포함관계로 기제작·기업로드 주제와 겹치는 후보를 제외.
 */
import { makeLogger } from '../lib/log.mjs';
import { loadConfig, pendingBacklog, loadIndex, loadBacklog, callClaude, extractJson, isMainModule, loadAgentBrief } from './lib.mjs';
import { inventoryCount } from './inventory.mjs';
import '../lib/force-subscription.mjs';

const log = makeLogger('curiosity/pick');

/** 최근 제작된 도메인일수록 freshness 감점(다양성). produced 순서 기반. */
export function freshnessMap(backlog, index) {
  const producedDomains = Object.entries(index)
    .filter(([, v]) => v.status === 'produced')
    .sort((a, b) => (a[1].at < b[1].at ? 1 : -1))   // 최신 먼저
    .map(([id]) => (backlog.find(b => b.id === id) || {}).domain)
    .filter(Boolean);
  // 최근 3개 도메인에 감점 가중
  const recent = producedDomains.slice(0, 3);
  return (domain) => {
    const idx = recent.indexOf(domain);
    return idx === -1 ? 1.0 : [0.4, 0.6, 0.8][idx];   // 가장 최근=강한 감점
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// US-003 콘텐츠 룰 (순수 함수 — 테스트: scripts/test/curiosity-content-rules.test.mjs)
// ─────────────────────────────────────────────────────────────────────────────

/** 유사도 비교용 조사·어미 목록(긴 것 먼저 — 최장일치). */
const JOSA = ['에서는', '으로는', '이라는', '에게서', '라는', '에서', '으로', '에게', '까지', '부터', '보다', '처럼', '만큼', '이나', '와의', '과의', '한테',
  '은', '는', '이', '가', '을', '를', '의', '에', '와', '과', '도', '만', '로', '랑'];

/** 어절 끝 조사 1개 절단(어간 2자 이상 보존). 유사도·태그 키워드 공용. */
export function stripJosa(word) {
  const w = String(word || '');
  if (w.length < 3) return w;
  for (const p of JOSA) {
    if (w.endsWith(p) && w.length - p.length >= 2) return w.slice(0, -p.length);
  }
  return w;
}

/**
 * 주제 정규화 — 공백/괄호/따옴표/문장부호 제거 + 어절별 조사 절단 후 이어붙임.
 * "총알 없는 총으로 자기 머리를 쐈던 배우 (공포탄의 진실)" 처럼 괄호 보충설명·조사만 다른
 * 재탕을 같은 문자열 계열로 모아 비교하기 위한 전처리(원문은 건드리지 않는다).
 */
export function normalizeSubject(s) {
  return String(s || '')
    .replace(/[()[\]{}<>《》「」『』"'“”‘’«»]/g, ' ')
    .replace(/[.,!?~·:;\-—–_/\\|+*=…%$#@&^]/g, ' ')
    .toLowerCase()
    .split(/\s+/).filter(Boolean)
    .map(stripJosa)
    .join('');
}

/** 문자 단위 bigram 집합. */
function charBigrams(s) {
  const set = new Set();
  for (let i = 0; i + 1 < s.length; i++) set.add(s.slice(i, i + 2));
  return set;
}

/** 두 주제의 정규화 유사도 → { jaccard, contained }. */
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

/**
 * 후보 주제가 기존 주제들과 사실상 같은 소재인지 판정.
 * 포함관계(한쪽이 다른쪽의 부분문자열) 또는 bigram Jaccard 임계 초과면 중복.
 */
export function isNearDuplicate(subject, existing, opts = {}) {
  const threshold = opts.bigram_jaccard ?? 0.45;
  const useSubstring = opts.substring !== false;
  let worst = { dup: false, jaccard: 0, against: null };
  for (const other of existing) {
    if (!other) continue;
    const { jaccard, contained } = subjectSimilarity(subject, other, opts);
    const dup = (useSubstring && contained) || jaccard >= threshold;
    if (dup) return { dup: true, jaccard: Number(jaccard.toFixed(3)), contained, against: other };
    if (jaccard > worst.jaccard) worst = { dup: false, jaccard: Number(jaccard.toFixed(3)), against: other };
  }
  return worst;
}

/** 이미 소비된(제작·업로드) 주제 목록 — 인덱스에 subject 가 없는 구항목은 백로그에서 보강. */
export function doneSubjects(index = {}, backlog = []) {
  const byId = new Map(backlog.map(b => [b.id, b]));
  return Object.entries(index)
    .filter(([, v]) => v.status === 'produced' || v.status === 'uploaded')
    .map(([id, v]) => v.subject || (byId.get(id) || {}).subject)
    .filter(Boolean);
}

/** KST(UTC+9) 기준 날짜키 YYYY-MM-DD — 일일 상한은 cron(KST 10/12/18시) 하루와 맞춘다. */
export function kstDayKey(t = new Date()) {
  const d = t instanceof Date ? t : new Date(t);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 오늘(KST) 제작·업로드된 항목의 angle 별 건수. angle 미저장 구항목은 reveal 로 간주. */
export function todayAngleCounts(index = {}, now = new Date()) {
  const day = kstDayKey(now);
  const counts = { whatif: 0, reveal: 0, total: 0 };
  for (const v of Object.values(index)) {
    if (v.status !== 'produced' && v.status !== 'uploaded') continue;
    if (kstDayKey(v.at) !== day) continue;
    counts[v.angle === 'whatif' ? 'whatif' : 'reveal']++;
    counts.total++;
  }
  return counts;
}

/**
 * 하루 whatif 상한(편수). config.pick.daily_whatif_cap 이 있으면 그대로,
 * 없으면 daily_target × backlog.angles.whatif_ratio 의 내림(3×0.35 → 1)으로 유도한다.
 */
export function whatifCap(cfg = {}) {
  const explicit = cfg.pick?.daily_whatif_cap;
  if (Number.isFinite(explicit)) return Math.max(0, Math.floor(explicit));
  const target = Number.isFinite(cfg.pick?.daily_target) ? cfg.pick.daily_target : 3;
  const ratio = Math.min(1, Math.max(0, cfg.backlog?.angles?.whatif_ratio ?? 0));
  return Math.max(0, Math.floor(target * ratio));
}

/** 오늘 남은 whatif 허용 편수(0 이면 whatif 후보 전면 제외). */
export function whatifAllowance(cfg = {}, index = {}, now = new Date()) {
  return Math.max(0, whatifCap(cfg) - todayAngleCounts(index, now).whatif);
}

/**
 * 채점 전 후보 필터 — 유사주제 중복(하드 룰) + whatif 일일 상한(소프트 룰).
 * 반환 { items(통과분), capBlocked(상한 때문에만 막힌 후보), blocked[...], allowance }.
 *
 * ⚠ 두 규칙의 위계가 다르다:
 *  - `similar_subject` = **하드 룰**. 중복 재업로드는 어떤 경우에도 내지 않는다 → 완화 대상 아님.
 *  - `whatif_daily_cap` = **소프트 룰**(다양성 선호). 하루 3편 발행이 룰이고 앵글 다양성은
 *    선호이므로, 슬롯이 빌 상황에서는 상한이 양보한다(decideRelaxation 참고).
 * 그래서 검사 순서도 유사도 먼저다 — 상한으로 먼저 걸러버리면 "중복이면서 whatif"인 후보가
 * capBlocked 에 섞여 완화 경로로 중복 업로드가 새어나간다.
 * ⚠ 편수 축소는 하지 않는다 — whatif 가 막히면 남은 reveal 후보가 그대로 슬롯을 채운다.
 */
export function filterCandidates({ items = [], index = {}, backlog = [], cfg = {}, now = new Date() } = {}) {
  const sim = cfg.pick?.similarity || {};
  const simOn = sim.enabled !== false;
  const done = doneSubjects(index, backlog);
  const allowance = whatifAllowance(cfg, index, now);
  const whatifDisabled = Number(cfg.backlog?.angles?.whatif_ratio ?? 0) === 0;
  const blocked = [];
  const capBlocked = [];
  const kept = items.filter(it => {
    // ① 하드 룰: 기제작·기업로드 주제와 사실상 같은 소재는 여기서 영구 탈락.
    if (simOn) {
      const d = isNearDuplicate(it.subject, done, sim);
      if (d.dup) {
        blocked.push({ id: it.id, subject: it.subject, reason: 'similar_subject', against: d.against, jaccard: d.jaccard });
        return false;
      }
    }
    // ② 소프트 룰: 오늘 whatif 상한 소진분은 보류만 한다(완화 후보로 남긴다).
    if (allowance <= 0 && it.angle === 'whatif') {
      blocked.push({ id: it.id, subject: it.subject, reason: whatifDisabled ? 'whatif_disabled' : 'whatif_daily_cap' });
      if (!whatifDisabled) capBlocked.push(it);
      return false;
    }
    return true;
  });
  return { items: kept, capBlocked, blocked, allowance };
}

/**
 * 업로드 가능한 재고(produced·미업로드) 편수. 판정 술어는 inventory.mjs 단일 출처를 쓴다
 * (자체 구현하면 run-curiosity 의 폴백 자격과 어긋나 "재고 있다고 보고 양보했는데 실제로는
 * 못 올리는" 불일치가 생긴다). 읽기 전용 import.
 */
export function availableInventory(index = loadIndex(), cfg = loadConfig()) {
  try { return inventoryCount(index, cfg); } catch { return 0; }
}

/**
 * 상한 완화 판정 — **하루 3편 룰이 앵글 다양성 선호를 이긴다.**
 * 우선순위: ① reveal 후보 → ② 재고(produced) 폴백 → ③ whatif 상한 완화. 0편보다 편중이 낫다.
 * 재고를 완화보다 먼저 두는 이유: 재고엔 reveal 이 있을 수 있고, 이미 만들어 둔 걸 내보내는
 * 편이 상한을 깨는 것보다 싸다. 재고 폴백 실행 자체는 상위(run-curiosity/slot) 소관이므로,
 * 재고가 있으면 완화하지 않고 canRelax 만 알려 상위가 판단하게 둔다.
 * @returns { relax, canRelax, reason }
 */
export function decideRelaxation({ strictCount = 0, relaxableCount = 0, inventory = 0 } = {}) {
  if (strictCount > 0) return { relax: false, canRelax: false, reason: 'strict_candidates_available' };
  if (relaxableCount <= 0) return { relax: false, canRelax: false, reason: 'no_relaxable_candidate' };
  if (inventory > 0) return { relax: false, canRelax: true, reason: 'inventory_fallback_first' };
  return { relax: true, canRelax: true, reason: 'slot_would_be_empty' };
}

/**
 * 정렬된 후보에서 최대 n건을 뽑되, 같은 배치 안에서도 whatif 를 allowance 편까지만 담는다
 * (best_n>=2 병행 제작 시 한 런에 whatif 가 몰리는 것 방지). 부족분은 reveal 로 채운다.
 *
 * relaxIfShort=true 면 reveal 로도 n 을 못 채울 때 **부족분만큼만** 상한 초과 whatif
 * (relaxable)를 채운다 — 상한을 무력화하는 게 아니라 빈 슬롯일 때만 1편씩 양보하는 것이다.
 * 채운 항목엔 relaxed=true 를 달아 상위·로그가 추적할 수 있게 한다.
 */
export function takeWithWhatifCap(sorted = [], n = 1, allowance = 0, { relaxable = [], relaxIfShort = false } = {}) {
  const out = [];
  let usedWhatif = 0;
  for (const s of sorted) {
    if (out.length >= n) break;
    if (s.item?.angle === 'whatif') {
      if (usedWhatif >= allowance) continue;
      usedWhatif++;
    }
    out.push(s);
  }
  if (!relaxIfShort) return out;
  const picked = new Set(out.map(s => s.item?.id));
  for (const s of relaxable) {
    if (out.length >= n) break;                 // 부족분만 — 최소 완화
    if (picked.has(s.item?.id)) continue;
    out.push({ ...s, relaxed: true });
  }
  return out;
}

export function buildScorePrompt(items) {
  const list = items.map(it => `{"id":"${it.id}","angle":${JSON.stringify(it.angle || 'reveal')},"subject":${JSON.stringify(it.subject)},"common_belief":${JSON.stringify(it.common_belief)},"reveal":${JSON.stringify(it.reveal)}}`).join('\n');
  const persona = loadAgentBrief('lynx');
  return `${persona ? persona + '\n\n' : ''}각 호기심 후보를 세 축으로 0.0~1.0 채점하라. 후보는 두 앵글이 섞여 있다 — angle="reveal"(설마 진짜? 사실 반전) 또는 angle="whatif"(만약 ~였다면? 근거 기반 가상 추론). 앵글에 맞게 공정히 채점하라.
- surprise: reveal=믿음↔사실 격차 강도 / whatif=결말(추론)의 의외성. 클수록 높음.
- scrollstop: 스크롤 멈추게 하는 호기심 유발력(첫 3초 훅 잠재력). whatif 는 전제 자체가 보편적으로 궁금할수록 높게.
- relatability: **실제 시청자가 빠져들 몰입도** — 내 몸·돈·관계·일상에 이해관계가 걸리거나, 사람의 드라마(서사)가 있으면 높게. "그래서 나랑 무슨 상관?"인 무미건조 잡학 퀴즈는 낮게.

[후보]
${list}

[출력] JSON 배열만: [{ "id":"...", "surprise":0.0, "scrollstop":0.0, "relatability":0.0 }]. 설명 없이.`;
}

/**
 * 후보 전원을 total 내림차순으로 스코어링(정렬)한다. pickBest/pickTopN 공유 코어 —
 * claude 배치 채점 결과(scores)를 한 번 받아 여기서만 가중합·정렬을 계산한다.
 */
export function scoreAll({ items, scores, freshOf, weights }) {
  const w = weights || { surprise: 0.34, scrollstop: 0.21, relatability: 0.30, freshness: 0.15 };
  const redditBonus = w.reddit_bonus ?? 0.05;   // 실제 인기 검증(Reddit 씨앗) 소폭 가점
  const byId = new Map(scores.map(s => [s.id, s]));
  const scored = items.map(it => {
    const s = byId.get(it.id) || { surprise: 0.5, scrollstop: 0.5, relatability: 0.5 };
    const fresh = freshOf(it.domain);
    // relatability 미채점(구버전 응답)이면 scrollstop 로 폴백해 회귀 없이 동작.
    const relat = s.relatability != null ? s.relatability : (s.scrollstop || 0.5);
    let total = (s.surprise || 0) * (w.surprise || 0)
      + (s.scrollstop || 0) * (w.scrollstop || 0)
      + relat * (w.relatability || 0)
      + fresh * (w.freshness || 0);
    // reddit 씨앗만 가점(실세계 인기 검증). whatif(항상 origin=llm·사고실험)는 실검증이 불가하므로
    // 의도적으로 제외 — surprise·scrollstop·relatability 로만 경쟁한다.
    if (it.origin === 'reddit') total += redditBonus;
    return { item: it, total, surprise: s.surprise, scrollstop: s.scrollstop, relatability: relat, freshness: fresh };
  });
  return scored.sort((a, b) => b.total - a.total);
}

/** 하위호환: 단일 best 반환(시그니처·반환 불변). scoreAll 위에서 계산한 1위를 그대로 돌려준다. */
export function pickBest({ items, scores, freshOf, weights }) {
  const sorted = scoreAll({ items, scores, freshOf, weights });
  return sorted[0] || null;
}

/** claude 배치 채점 1콜 + freshness 계산을 공유하는 내부 코어. pick()/pickTopN() 이 함께 사용. */
async function scoreCandidates() {
  const cfg = loadConfig();
  const backlog = loadBacklog();
  const index = loadIndex();
  const all = pendingBacklog();
  // US-003 — 채점(claude 1콜) 전에 앵글 상한·유사중복을 걷어낸다(토큰 절약 + 규칙 확정).
  const { items, capBlocked, blocked, allowance } = filterCandidates({ items: all, index, backlog, cfg });
  for (const b of blocked) {
    if (b.reason === 'whatif_daily_cap') {
      log.info(`후보 보류(whatif 일일 상한 ${whatifCap(cfg)}편 소진, 완화 후보로 남김): ${b.subject}`);
    } else if (b.reason === 'whatif_disabled') {
      log.info(`후보 제외(whatif 성과 대응 일시중지): ${b.subject}`);
    } else {
      log.info(`후보 제외(유사주제 중복 j=${b.jaccard}): ${b.subject} ↔ "${b.against}"`);
    }
  }
  const inventory = availableInventory(index, cfg);
  // 상한 보류분(capBlocked)도 같은 배치 1콜에서 함께 채점한다 — 완화가 필요해진 순간에
  // 채점을 위해 claude 를 한 번 더 부르지 않도록(슬롯 지연·추가 비용 방지).
  const scoreTargets = [...items, ...capBlocked];
  if (scoreTargets.length === 0) {
    return { cfg, items, sorted: [], relaxable: [], blocked, allowance, inventory, hadCandidates: all.length > 0 };
  }
  const text = callClaude(buildScorePrompt(scoreTargets));
  let scores;
  try { scores = extractJson(text); } catch { throw new Error('점수 JSON 파싱 실패'); }
  if (!Array.isArray(scores)) throw new Error('점수 응답이 배열 아님');
  const freshOf = freshnessMap(backlog, index);
  const sorted = items.length ? scoreAll({ items, scores, freshOf, weights: cfg.pick?.weights }) : [];
  const relaxable = capBlocked.length ? scoreAll({ items: capBlocked, scores, freshOf, weights: cfg.pick?.weights }) : [];
  return { cfg, items, sorted, relaxable, blocked, allowance, inventory, hadCandidates: all.length > 0 };
}

export async function pick() {
  const { cfg, sorted, relaxable = [], blocked = [], inventory = 0, hadCandidates } = await scoreCandidates();
  if (sorted.length === 0) {
    // 상한 때문에만 막힌 후보가 있으면 "0편 발행"보다 완화가 낫다(3편 룰 > 다양성 선호).
    const d = decideRelaxation({ strictCount: 0, relaxableCount: relaxable.length, inventory });
    if (d.relax) {
      const best = relaxable[0];
      log.warn(`whatif 일일 상한 완화 — 발행 슬롯 공백 방지 우선(상한 ${whatifCap(cfg)}편 초과 발행, reveal 후보 0건·재고 0편): ${best.item.subject}`);
      return {
        pick: best.item, score: best.total,
        breakdown: { surprise: best.surprise, scrollstop: best.scrollstop, relatability: best.relatability, freshness: best.freshness },
        reason: 'ok(whatif 상한 완화)', relaxed: true, relaxation: 'whatif_daily_cap', blocked,
      };
    }
    // 완화 안 함 — 상위가 판단할 수 있게 "완화하면 뽑을 수 있음"을 구별해 알린다.
    const reason = d.canRelax
      ? `whatif 상한 소진(재고 ${inventory}편 폴백 우선) — 완화 가능 후보 ${relaxable.length}건`
      : (hadCandidates && blocked.length
        ? `콘텐츠 룰로 후보 없음(유사중복 등 ${blocked.length}건 제외)`
        : '미제작 백로그 없음');
    return { pick: null, reason, blocked, canRelax: d.canRelax, relaxableCount: relaxable.length, inventory };
  }
  const best = sorted[0];
  return { pick: best.item, score: best.total, breakdown: { surprise: best.surprise, scrollstop: best.scrollstop, relatability: best.relatability, freshness: best.freshness }, reason: 'ok' };
}

/**
 * 상위 n건을 total 내림차순으로 반환(AC-8: best_n>=2 A/B 병행 제작용).
 * 채점(claude 배치 1콜)은 pick() 과 동일 코어(scoreCandidates)를 재사용 — 중복 호출 없음.
 * 반환: { picks: [{item, score, breakdown}...], reason }. 후보가 n 미만이면 있는 만큼.
 */
export async function pickTopN(n) {
  const { cfg, sorted, relaxable = [], blocked = [], allowance = 0, inventory = 0, hadCandidates } = await scoreCandidates();
  if (sorted.length === 0 && relaxable.length === 0) {
    const reason = hadCandidates && blocked.length
      ? `콘텐츠 룰로 후보 없음(유사중복 등 ${blocked.length}건 제외)`
      : '미제작 백로그 없음';
    return { picks: [], reason, blocked };
  }
  // 같은 배치 안에서도 whatif 는 남은 허용량까지만 — 부족분은 reveal 로 채워 편수는 유지.
  // reveal 로도 못 채우고 재고도 없으면(=슬롯 공백) 부족분만큼만 상한을 완화한다.
  // 재고가 있으면 완화하지 않는다 — 부족분은 상위의 재고 폴백이 채운다(완화보다 우선).
  const relaxIfShort = relaxable.length > 0 && inventory === 0;
  const taken = takeWithWhatifCap(sorted, n, allowance, { relaxable, relaxIfShort });
  const picks = taken.map(s => ({
    item: s.item,
    score: s.total,
    breakdown: { surprise: s.surprise, scrollstop: s.scrollstop, relatability: s.relatability, freshness: s.freshness },
    ...(s.relaxed ? { relaxed: true } : {}),
  }));
  const relaxedN = picks.filter(p => p.relaxed).length;
  if (relaxedN) {
    log.warn(`whatif 일일 상한 완화 ${relaxedN}편 — 발행 슬롯 공백 방지 우선(상한 ${whatifCap(cfg)}편, 재고 ${inventory}편): ${picks.filter(p => p.relaxed).map(p => p.item.subject).join(' / ')}`);
  }
  return { picks, reason: relaxedN ? `ok(whatif 상한 완화 ${relaxedN}편)` : 'ok', ...(relaxedN ? { relaxed: true, relaxation: 'whatif_daily_cap' } : {}) };
}

async function main() {
  try {
    const r = await pick();
    if (r.pick) log.info(`best-pick: ${r.pick.subject} (점수 ${r.score.toFixed(3)})`);
    else log.info(`선정 없음: ${r.reason}`);
    process.stdout.write(JSON.stringify({ ok: true, ...r }) + '\n');
  } catch (e) {
    log.error(`선정 실패: ${e.message}`);
    process.stdout.write(JSON.stringify({ ok: false, reason: e.message }) + '\n');
    process.exit(2);
  }
}

if (isMainModule(import.meta.url)) main();
