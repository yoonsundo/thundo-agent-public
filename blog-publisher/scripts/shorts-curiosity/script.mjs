#!/usr/bin/env node
/**
 * shorts-curiosity/script.mjs — 반전 사실 1건 → 카드형 쇼츠 대본(JSON)
 *
 * 백로그 아이템(주제·흔한믿음·반전·근거)을 30~60초 "설마 진짜?" 카드 대본으로.
 * 산출은 scripts/shorts/ 엔진과 동일한 script.json 스키마 → 이후 imagen/slides/tts/assemble 재사용.
 * parseScript 검증은 shorts/script.mjs 재사용.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeLogger } from '../lib/log.mjs';
import { loadConfig, slugify, callClaude, isMainModule, loadAgentBrief } from './lib.mjs';
import { loadInsights, insightsMetaLabel } from './backlog.mjs';
import { parseScript } from '../shorts/script.mjs';
import { workDir } from '../shorts/lib.mjs';
import '../lib/force-subscription.mjs';

const log = makeLogger('curiosity/script');

/* ──────────────────────────────────────────────────────────────────────────
 * 길이 예산 — 영상이 주차마다 길어지는 것을 막는 결정론 가드
 *
 * 실측(감사 2026-07-30, 37편): 1주 40.8초 → 2주 48.8초 → 3주 53.8초로 계속 길어졌고
 * 30초 미만은 0편이었다. 게이트가 15~75초를 허용하니 LLM 이 매번 상한 쪽에 붙은 것.
 * Shorts 에서 완주율·재시청은 지배적 랭킹 신호라 같은 반전을 55초로 늘려 말하면 손해다.
 *
 * 캘리브레이션(제작완료 51편 ffprobe 실측): 총 나레이션 음절 ↔ 영상 길이는
 *   dur ≈ SEC_PER_SYLLABLE × 음절 + (pad_head + pad_tail)
 * 로 잘 맞는다(초당 5.2음절, s/syl 중위 0.198·평균 0.194). 51편 선형회귀는
 * dur = 0.2365×syl − 9.82 였으나 절편이 음수라 짧은 대본에서 과소추정 → 비례+고정
 * 오버헤드 모델을 쓴다. 검증: 음절 236(평균) → 45.9초 예측 vs 실측 평균 46.0초.
 * ────────────────────────────────────────────────────────────────────────── */

/** 음절당 초(실측 캘리브레이션). config `script.sec_per_syllable` 로 덮어쓸 수 있다. */
const SEC_PER_SYLLABLE = 0.191;
/** pad_head+pad_tail 을 config 에서 못 읽을 때의 고정 오버헤드(현 설정 0.3+0.6). */
const FALLBACK_OVERHEAD_SEC = 0.9;
/** 지향 목표 구간(초). 게이트 허용범위(15~75)가 아니라 '완주율 최적' 구간이다. */
const DEFAULT_TARGET_SEC = [35, 45];
/** whatif 상한 배율 — '만약~' 앵글은 전제 설정에 시간을 더 써 구조적으로 길어진다(감사 3.9). */
const DEFAULT_WHATIF_FACTOR = 0.93;
/** hook·cta 음절 상하한. 기존 프롬프트(hook 12~28·cta 20~35)에서 상단을 깎았다. */
const HOOK_SYL = [12, 22];
const CTA_SYL = [18, 26];
/** 하한 경고 유예(초) — 추정 오차(절대평균 3.4초)만큼은 목표선 밑도 정상으로 본다. */
const UNDER_TOLERANCE_SEC = 4;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 한글 음절 수(나레이션 길이의 실질 단위 — 라틴·숫자·기호는 세지 않는다). */
export function countSyllables(text) {
  return (String(text ?? '').match(/[가-힣]/g) || []).length;
}

/** 대본 전체(hook + 카드 나레이션 + cta) 음절 합. 비정형 입력도 0 으로 안전. */
export function totalSyllables(script) {
  if (!script || typeof script !== 'object') return 0;
  const cards = Array.isArray(script.cards) ? script.cards : [];
  return countSyllables(script.hook) + countSyllables(script.cta)
    + cards.reduce((a, c) => a + countSyllables(c?.narration), 0);
}

/** config 의 pad 설정에서 고정 오버헤드(초)를 얻는다. */
function overheadSec(cfg) {
  const h = Number(cfg?.video?.pad_head_sec), t = Number(cfg?.video?.pad_tail_sec);
  if (Number.isFinite(h) && Number.isFinite(t)) return h + t;
  return FALLBACK_OVERHEAD_SEC;
}
function secPerSyllable(cfg) {
  const k = Number(cfg?.script?.sec_per_syllable);
  return k > 0 ? k : SEC_PER_SYLLABLE;
}

/** 음절 → 예상 영상 길이(초). */
export function estimateSeconds(syllables, cfg) {
  return +((Math.max(0, Number(syllables) || 0) * secPerSyllable(cfg)) + overheadSec(cfg)).toFixed(1);
}
/** 초 → 허용 음절(estimateSeconds 의 역함수). */
function secondsToSyllables(sec, cfg) {
  return Math.max(0, (Number(sec) - overheadSec(cfg)) / secPerSyllable(cfg));
}

/**
 * 앵글별 길이 예산. 목표는 "35~45초에 반전 하나를 완결".
 * @param maxSecHint 성과 인사이트가 더 짧은 최적 구간을 알려줄 때만 상한을 **내린다**.
 *   올리지는 않는다 — insights 가 '51초+ 구간이 좋다'고 해도 길이 창궐을 되돌리면 안 되고,
 *   그런 신호는 표본 편향(현재 전부 긴 영상뿐)일 가능성이 크기 때문(감사 지적의 근본 원인).
 */
export function lengthBudget(cfg, angle, { maxSecHint } = {}) {
  const isWhatIf = angle === 'whatif';
  const gateMin = Number(cfg?.gates?.min_sec) || 15;
  const [cfgLo, cfgHi] = Array.isArray(cfg?.script?.total_target_sec) ? cfg.script.total_target_sec : [30, 65];
  const [tLo, tHi] = Array.isArray(cfg?.script?.target_sec) ? cfg.script.target_sec : DEFAULT_TARGET_SEC;

  // 하한: 게이트 하한(15초)은 절대 건드리지 않는다 — 목표 하한을 그보다 넉넉히 위에 둔다.
  let lo = clamp(Number(tLo) || DEFAULT_TARGET_SEC[0], gateMin + 5, 60);
  lo = Math.max(lo, Number(cfgLo) || 0);
  let hi = clamp(Number(tHi) || DEFAULT_TARGET_SEC[1], lo + 5, Number(cfgHi) || 65);
  // insights 힌트는 '내리는' 방향으로만 반영.
  const hint = Number(maxSecHint);
  if (Number.isFinite(hint) && hint >= lo + 3 && hint < hi) hi = hint;
  if (isWhatIf) {
    const f = Number(cfg?.script?.whatif_length_factor) > 0 ? Number(cfg.script.whatif_length_factor) : DEFAULT_WHATIF_FACTOR;
    hi = Math.max(lo + 3, Math.round(hi * f));
  }

  const maxSyl = Math.max(60, Math.round(secondsToSyllables(hi, cfg)));
  const minSyl = Math.max(40, Math.round(secondsToSyllables(lo, cfg)));
  // 하한 '경고' 임계는 목표 하한보다 UNDER_TOLERANCE_SEC 아래에서만 울린다. 추정 오차가
  // 절대평균 3.4초(실측 50편)라 목표선에 딱 붙은 대본(예: 34.5초)까지 경고하면 로그만 시끄럽다.
  const underSyl = Math.max(40, Math.round(secondsToSyllables(Math.max(lo - UNDER_TOLERANCE_SEC, (Number(cfg?.gates?.min_sec) || 15) + 2), cfg)));
  const minCards = Number(cfg?.script?.min_cards) || 3;
  const maxCards = Number(cfg?.script?.max_cards) || 4;
  // 카드당 상한은 총예산에서 hook·cta 몫을 뺀 뒤 최대 카드 수로 나눠 역산 → 상한끼리 모순 없음.
  const reserve = HOOK_SYL[1] + CTA_SYL[1];
  const [cardLoCfg] = Array.isArray(cfg?.script?.narration_syllables_per_card) ? cfg.script.narration_syllables_per_card : [35, 60];
  const perCardHi = Math.max((Number(cardLoCfg) || 35) + 4, Math.floor((maxSyl - reserve) / maxCards));
  // 하한은 config 값을 존중(과하게 깎아 정보가 빠지는 것 방지) — 단 상한보다 낮게.
  const perCardLo = Math.min(Number(cardLoCfg) || 35, perCardHi - 6);
  // 프롬프트에 적을 '최소 분량'. minSyl 을 그대로 쓰면 min_cards(3)장으로는 도달 불가능한
  // 지시가 된다(3×perCardHi + hook·cta 하한 < minSyl) → 실제로 달성 가능한 값으로 낮춘다.
  // perCardHi 는 max_cards 기준이라(4장이 예산을 넘지 않게) 3장 조합에선 총량이 모자랄 수 있다.
  const floorSyl = Math.min(minSyl, minCards * perCardHi + HOOK_SYL[0] + CTA_SYL[0]);
  // 프롬프트가 허용한 최소 분량(floorSyl)을 지킨 대본에 하한 경고를 띄우면 자기모순 → 항상 그 아래로.
  const warnSyl = Math.min(underSyl, floorSyl - 1);

  return { angle: isWhatIf ? 'whatif' : 'reveal', targetLo: lo, targetHi: hi, maxSyl, minSyl, floorSyl, underSyl: warnSyl, minCards, maxCards, perCardLo, perCardHi };
}

/** 대본이 예산 안인지 판정(결정론). */
export function checkLength(script, budget, cfg) {
  const syllables = totalSyllables(script);
  return {
    syllables,
    est_sec: estimateSeconds(syllables, cfg),
    over: syllables > budget.maxSyl,
    over_by: Math.max(0, syllables - budget.maxSyl),
    // 차단이 아니라 경고용(정보량 점검). 유예선(underSyl) 아래에서만 울린다.
    under: syllables < (budget.underSyl ?? budget.minSyl),
  };
}

/** 문장 경계 분리(종결부호 유지) — 프로소디가 문장부호 기반이라 경계를 지켜야 더빙이 안 깨진다. */
function splitSentences(text) {
  return String(text ?? '').split(/(?<=[.!?…])\s+/).map(s => s.trim()).filter(Boolean);
}

/**
 * 예산 초과 대본을 결정론적으로 축약. LLM 재생성이 실패했을 때의 마지막 수단.
 * ① 마지막 카드 제거 — 흐름상 마지막은 '여운/한 줄 정리'라 정보 손실이 가장 적다(핵심 반전은 앞).
 * ② 가장 긴 카드의 마지막 문장 제거 — 문장 단위라 TTS·프로소디가 깨지지 않는다.
 * 둘 다 minSyl 하한과 min_cards 를 침범하지 않는다(짧아져서 정보량·게이트가 깨지면 안 됨).
 */
export function trimToBudget(script, budget, cfg) {
  const out = { ...script, cards: (Array.isArray(script?.cards) ? script.cards : []).map(c => ({ ...c })) };
  const actions = [];

  // ① 카드 제거
  while (out.cards.length > budget.minCards && totalSyllables(out) > budget.maxSyl) {
    const trial = { ...out, cards: out.cards.slice(0, -1) };
    if (totalSyllables(trial) < budget.minSyl) break;      // 너무 짧아지면 중단
    const lost = countSyllables(out.cards[out.cards.length - 1]?.narration);
    out.cards = trial.cards;
    actions.push(`마지막 카드 제거(-${lost}음절)`);
  }

  // ② 문장 제거 (무한루프 방지 가드 — 실제 대본은 카드당 몇 문장이라 넉넉히 잡아도 싸다.
  //    가드가 낮으면 '축약 실패'가 아니라 '가드 소진'으로 오판돼 경고가 잘못 뜬다)
  for (let guard = 0; guard < 200 && totalSyllables(out) > budget.maxSyl; guard++) {
    let idx = -1, longest = -1;
    out.cards.forEach((c, i) => {
      const n = countSyllables(c?.narration);
      if (n > longest) { longest = n; idx = i; }
    });
    if (idx < 0) break;
    const sents = splitSentences(out.cards[idx].narration);
    if (sents.length < 2) break;                            // 한 문장뿐 → 더 깎으면 의미가 깨진다
    const shortened = sents.slice(0, -1).join(' ');
    if (countSyllables(shortened) < Math.min(20, budget.perCardLo)) break;   // 카드가 빈약해지면 중단
    const trial = { ...out, cards: out.cards.map((c, i) => (i === idx ? { ...c, narration: shortened } : c)) };
    if (totalSyllables(trial) < budget.minSyl) break;
    out.cards = trial.cards;
    actions.push(`카드 ${idx + 1} 마지막 문장 제거`);
  }

  return { script: out, actions, still_over: totalSyllables(out) > budget.maxSyl };
}

/** 길이 예산 → 프롬프트 제약 블록. 목표를 범위 상단이 아니라 하단~중앙으로 못박는다. */
export function lengthPromptBlock(budget, cfg) {
  const mid = Math.round((budget.targetLo + budget.targetHi) / 2);
  const floor = budget.floorSyl ?? budget.minSyl;
  const whatifNote = budget.angle === 'whatif'
    ? `\n- ⚠ "만약 ~였다면?" 앵글은 전제 설정에 말을 더 쓰다가 매번 길어진다(실측 확인). **전제는 한 문장으로 끝내고** 곧바로 결말·2차효과로 넘어가라. 이 앵글은 상한이 ${budget.targetHi}초로 더 짧다 — reveal 보다 더 압축해야 한다.`
    : '';
  return `[길이 — 최우선 제약 (완주율이 Shorts 랭킹을 지배한다)]
- **목표 ${budget.targetLo}~${budget.targetHi}초. 짧을수록 좋다.** 같은 반전 하나를 ${budget.targetHi}초로 늘려 말하면 ${budget.targetLo}초판보다 완주율이 떨어진다. 상한에 붙이지 말고 **${budget.targetLo}~${mid}초를 노려라**.
- **총 나레이션(hook + 카드 전체 + cta) ${budget.maxSyl}음절 이내** — 하드 상한이다(초과하면 기계가 카드·문장을 잘라낸다).
- 카드는 ${budget.minCards}~${budget.maxCards}장. **${budget.minCards}장으로 완결되면 ${budget.maxCards}장을 만들지 마라** — 카드를 채우려고 내용을 늘리는 건 최악이다.
- 카드당 나레이션 ${budget.perCardLo}~${budget.perCardHi}음절 / hook ${HOOK_SYL[0]}~${HOOK_SYL[1]}음절 / cta ${CTA_SYL[0]}~${CTA_SYL[1]}음절.
- **너무 짧아도 실패다**: 총 ${floor}음절 이상(≈${estimateSeconds(floor, cfg)}초)은 채워라 — 반전의 근거가 빠지면 짧아도 의미가 없다.${whatifNote}

[군더더기 제거 — 위 예산을 지키는 방법]
- 전제·배경은 반전을 이해하는 데 꼭 필요한 최소한만. "옛날에는~", "다들 알다시피~" 같은 도입부 워밍업 문장 금지.
- **같은 내용을 다른 말로 다시 말하지 마라**(카드 간 재진술 금지). 각 카드는 새 정보를 하나씩만 얹는다.
- 강조어·수식어 반복 제거("정말/진짜/무려/심지어/놀랍게도"를 겹쳐 쓰지 마라).
- 근거는 한 문장으로 끝내라(기관·인물·연도만). 근거를 길게 설명하지 마라.
- 훅은 첫 문장에서 끝내고 바로 본론으로. 뜸들이는 문장·괜한 되묻기 금지.`;
}

/**
 * 길이 예산을 만족하는 대본을 확보한다 — 생성기를 주입받는 순수 제어 로직.
 *
 * ① 예산 내면 즉시 채택. ② 초과면 **초과 사실을 힌트로 붙여 재생성**(맹목 재시도는 같은 상한에
 * 또 붙는다). ③ 시도를 다 쓰면 최단 후보를 결정론 축약. ④ 축약 후에도 초과면 경고만 남기고
 * 통과 — 발행 공백보다 약간 긴 영상이 낫다는 운영 원칙(절대 상한은 gates.max_sec 가 따로 잡음).
 *
 * @param generate (lengthHint) => parsedScript. throw 하면 그 시도만 실패로 처리하고 계속.
 */
export function resolveScriptWithBudget({ generate, budget, cfg, attempts = 3, logger = log }) {
  const maxAttempts = Math.max(1, Number(attempts) || 1);
  let lastErr, lengthHint = '', attemptsUsed = 0;
  // 예산 초과여도 스키마는 유효한 '최단' 후보 — 재생성이 전부 실패했을 때의 폴백(발행 공백 방지).
  let best = null;

  for (let i = 1; i <= maxAttempts; i++) {
    attemptsUsed = i;
    let cand;
    try {
      cand = generate(lengthHint);
    } catch (e) {
      lastErr = e;
      logger.warn(`대본 생성 시도 ${i}/${maxAttempts} 실패: ${e.message}`);
      continue;
    }
    const chk = checkLength(cand, budget, cfg);
    if (!chk.over) {
      logger.info(`길이 검증 통과: ${chk.syllables}음절 ≈ ${chk.est_sec}초 (카드 ${Array.isArray(cand.cards) ? cand.cards.length : 0}장)`);
      // 하한 미달은 차단하지 않는다(게이트 하한 15초는 한참 아래) — 정보량 점검용 경고만.
      if (chk.under) logger.warn(`길이 하한 미달: ${chk.syllables}음절 ≈ ${chk.est_sec}초 < 목표 ${budget.targetLo}초 — 정보량 확인 필요(게이트 하한 ${cfg?.gates?.min_sec ?? 15}초는 여유)`);
      return { script: cand, check: chk, attempts_used: i, trimmed: [], still_over: false };
    }
    if (!best || chk.syllables < best.chk.syllables) best = { cand, chk };
    logger.warn(`길이 예산 초과(시도 ${i}/${maxAttempts}): ${chk.syllables}음절 ≈ ${chk.est_sec}초 > 예산 ${budget.maxSyl}음절(${budget.targetHi}초) — ${chk.over_by}음절 초과`);
    lengthHint = `⚠ 직전 시도는 총 ${chk.syllables}음절(약 ${chk.est_sec}초)로 예산을 ${chk.over_by}음절 초과했다. 이번엔 **반드시 총 ${budget.maxSyl}음절(약 ${budget.targetHi}초) 이내**로 줄여라 — 카드 수를 ${budget.minCards}장으로 줄이거나, 각 카드에서 군더더기 문장(전제 설명·재진술·강조어)을 빼라. 사실과 반전은 유지하고 말만 줄여라.`;
  }

  if (!best) throw lastErr || new Error('대본 생성 실패');

  // 결정론 축약(마지막 카드 제거 → 가장 긴 카드의 마지막 문장 제거).
  const trimmed = trimToBudget(best.cand, budget, cfg);
  for (const a of trimmed.actions) logger.warn(`길이 축약 — ${a}`);
  const after = checkLength(trimmed.script, budget, cfg);
  if (trimmed.still_over) {
    logger.warn(`길이 예산 초과 잔존: ${after.syllables}음절 ≈ ${after.est_sec}초 (예산 ${budget.maxSyl}음절) — 축약 한계·정보량 보호로 그대로 통과시킨다(발행 공백 방지)`);
  } else {
    logger.info(`길이 축약 완료: ${best.chk.syllables} → ${after.syllables}음절 ≈ ${after.est_sec}초`);
  }
  if (after.under) {
    logger.warn(`길이 하한 미달: ${after.syllables}음절 ≈ ${after.est_sec}초 < 목표 ${budget.targetLo}초 — 정보량 확인 필요(게이트 하한 ${cfg?.gates?.min_sec ?? 15}초는 여유)`);
  }
  return { script: trimmed.script, check: after, attempts_used: attemptsUsed, trimmed: trimmed.actions, still_over: trimmed.still_over };
}

/**
 * 성과 인사이트 → 대본 프롬프트용 지시문 블록. ins 없으면 빈 문자열(기존 프롬프트 그대로).
 * 방어적 로딩·정규화는 backlog.mjs 의 loadInsights 가 담당(폐루프 로더 단일화) — 여기선
 * 훅·제목 방향으로 번역만 한다. 도메인 성과는 "이 소재가 부진군이면 훅을 더 세게" 맥락으로 쓴다.
 */
export function insightsScriptBlock(ins, item = {}) {
  if (!ins || typeof ins !== 'object') return '';
  // 배열 필드는 loadInsights 가 보장하지만, 손으로 만든 ins 가 들어와도 throw 하지 않도록 방어.
  const arr = (v) => (Array.isArray(v) ? v.filter(Boolean).map(String) : []);
  const titlePatterns = arr(ins.title_patterns), topDomains = arr(ins.top_domains);
  const bottomDomains = arr(ins.bottom_domains), guidance = arr(ins.guidance);
  const lines = [];
  if (titlePatterns.length) lines.push(`- 성과 상위 영상의 제목/훅 패턴: ${titlePatterns.join(' / ')}`);
  if (ins.title_length) lines.push(`- 성과 최고 제목 길이 구간: ${ins.title_length}자 → caption·훅 길이 감각의 참고선`);
  if (ins.top_angle) lines.push(`- 성과 우수 앵글: ${ins.top_angle}`);
  if (topDomains.length) lines.push(`- 성과 우수 도메인: ${topDomains.join(', ')}`);
  if (bottomDomains.length) lines.push(`- 성과 부진 도메인: ${bottomDomains.join(', ')}`);
  for (const g of guidance) lines.push(`- ${g}`);   // evolve 가 써 준 문장 원문(훅 구조·사례 결)
  if (!lines.length) return '';
  const dom = String(item?.domain || '').trim();
  // 이 소재의 도메인이 부진군이면 훅을 더 세게 — 도메인 자체는 이미 선정에서 결정됐으니
  // 대본 단계가 할 수 있는 보정은 "훅 강도"뿐이다.
  const domNote = dom && bottomDomains.some(d => d.startsWith(dom))
    ? `\n- ⚠ 이 소재의 도메인(${dom})은 부진군이다 → 훅과 첫 카드에서 payoff 를 더 앞당겨라(뜸들이지 말 것).`
    : '';
  const directive = ins.strength === 'full'
    ? `→ 훅과 caption 을 위 패턴 방향으로 기울여라.`
    : `→ 데이터 신뢰도가 낮으니 **약한 참고만** 하라(위 표본·집계시점 확인). 억지로 맞추지 말 것.`;
  return `[최근 유튜브 성과 학습 — ${insightsMetaLabel(ins)}]
${lines.join('\n')}${domNote}

${directive}
단, 이 소재에 안 맞는 패턴을 억지로 끼워맞추지 마라 — 소재의 구체 디테일이 항상 우선이고, 위 [훅 형태]의 다양성 규칙(질문 일변도 금지·매번 다른 형태)을 깨서는 안 된다.`;
}

export function buildPrompt(item, cfg, ins, { lengthHint, budget } = {}) {
  const persona = loadAgentBrief('nightingale');
  const isWhatIf = item.angle === 'whatif';
  // 길이 예산 — 카드 수·카드당 음절 상한이 전부 여기서 나온다(프롬프트와 검증부가 같은 수를 본다).
  const bud = budget || lengthBudget(cfg, item.angle);
  const min = bud.minCards, max = bud.maxCards;
  const lo = bud.perCardLo, hi = bud.perCardHi;

  // 앵글별 소재 라벨·서사 흐름·훅·사실규칙 (whatif=가상 추론 / reveal=사실 폭로)
  const intro = isWhatIf
    ? '아래 "만약 ~였다면?" 사고실험을 30~60초 세로 쇼츠 카드 대본으로 만들어라. 가볍고 캐주얼하게, 첫 3초에 "그거 궁금했는데!" 호기심을 터뜨려라.'
    : '아래 반전 사실을 30~60초 세로 쇼츠 카드 대본으로 만들어라. 가볍고 캐주얼하게, 첫 3초에 호기심을 터뜨려라.';
  const sourceBlock = isWhatIf
    ? `[소재]
가정(주제): ${item.subject}
흔한 상상: ${item.common_belief}
근거 기반 추론(결말): ${item.reveal}
지탱 근거: ${item.source_hint || ''}`
    : `[소재]
주제: ${item.subject}
흔한 믿음: ${item.common_belief}
반전 사실: ${item.reveal}
근거: ${item.source_hint || ''}`;
  const flow = isWhatIf
    ? '[호기심 훅] → [실제로는 이런 조건/제약이었다(근거)] → [그래서 아마 이렇게 됐을 것(의외의 결말·2차효과)] → (있으면) [여운/현대와 연결].'
    : '[호기심 훅] → [반전 공개] → [왜/근거 간단히] → (있으면) [여운/한 줄 정리].';
  const hookInstr = isWhatIf
    ? `"hook": 맨 처음 성우 한 문장(${HOOK_SYL[0]}~${HOOK_SYL[1]}음절) — 이 "만약 ~였다면?" 가정을 첫 문장에 심되, 아래 [훅 형태]에서 매번 다른 하나를 골라 던져라(꼭 물음표로 끝낼 필요 없다).`
    : `"hook": 맨 처음 성우 한 문장(${HOOK_SYL[0]}~${HOOK_SYL[1]}음절) — 이 반전의 씨앗을 첫 문장에 심되, 아래 [훅 형태]에서 매번 다른 하나를 골라 던져라.`;
  const perf = insightsScriptBlock(ins, item);   // 성과 학습 주입(없으면 빈 문자열)
  const lenBlock = lengthPromptBlock(bud, cfg);
  // 재생성 힌트: 직전 시도가 예산을 넘었다는 사실을 명시해야 LLM 이 실제로 줄인다
  // (맹목 재시도는 같은 상한에 또 붙는다 — 실측된 길이 창궐의 원인).
  const retry = String(lengthHint || '').trim();
  const factRule = isWhatIf
    ? '결말은 근거에 기반한 추론이다 — 단정("~이다") 말고 "~였을 거예요/아마" 톤으로. 근거 없는 판타지·초자연·과장 금지(실제 물리·역사·생리 제약 안에서). caption·narration 에 이모지·해시태그 금지.'
    : '사실은 반전 사실 그대로. 과장·창작 금지. caption·narration 에 이모지·해시태그 금지.';

  return `${persona ? persona + '\n\n' : ''}${retry ? retry + '\n\n' : ''}${intro}

${sourceBlock}

${lenBlock}

[더빙 자연스러움 — 최우선]
- narration 은 성우가 실제로 "말하듯" 읽는 자연 구어체다. AI 티(번역체·딱딱한 문어체·리스트 나열·균일한 문장리듬)를 철저히 배격.
- 문장 길이를 불규칙하게 교차(짧게 치고, 가끔 길게 풀고). 질문형·평서형·감탄형을 섞어 리듬에 개성을 줘라. 단, 과장·오글거림 금지.
- 자연스러운 쉼을 위해 문장 끝은 마침표/물음표로 또렷이 끊고, 한 호흡에 읽히도록 너무 긴 문장은 쪼개라.

[TTS 친화 — 성우가 혀 안 꼬이게]
- 숫자는 되도록 한글로 풀어써라(예: "56km/h" → "시속 오십육 킬로", "1519년" → "천오백십구년"). 아라비아 숫자·단위기호 나열 금지.
- 영어 대문자 약어·라틴 표기는 지양. 꼭 필요하면 한글 음차로(예: "DNA" → "디엔에이", "GPS" → "지피에스").
- 혀 꼬이는 자음군·과한 수식어 겹침을 피하고, 소리 내 읽었을 때 매끄러운 어절을 골라라.

[반복 금지 — 매번 다르게]
- 카드 첫 어절이 전부 같은 연결어("근데/그래서/그러니까/사실은/반전은")로 시작하면 안 된다. 각 카드의 문장 시작을 서로 다르게(장면·인물·숫자·직접호명·짧은 단언 등으로) 열어라.
- "소름 돋는", "설마", "충격", "미쳤다" 같은 상투어 남발 금지. 소재 자체의 구체 디테일로 놀라움을 만들어라.

[훅 형태 — 매번 다른 하나를 골라라 (질문 일변도 금지)]
- 대담한 단언: 통념을 정면으로 뒤집는 한 문장 선언.
- 숫자 충격: 의외의 수치·규모를 앞세워 던지기(한글로 풀어서).
- 장면 던지기: 한복판 장면부터 훅 열기(in medias res).
- 흔한믿음 부정: "다들 ~라고 아는데, 아니에요" 식 부정.
- 모순 결합: 안 어울리는 두 가지를 한 문장에 붙여 긴장 주기.
- "~겠죠?/~죠?/말이 되나요?" 같은 질문형으로만 반복해서 열지 마라.

[CTA — 고정 템플릿 금지]
- "이런 소름 돋는 반전/진짜 이야기, 궁금하면 구독" 같은 판박이 마무리를 절대 쓰지 마라.
- 이 소재에 밀착한 자연스러운 마무리 한 줄로, 구독 유도 방식도 매번 다른 형태로: 여운을 남기는 한 줄 / 가벼운 위트 / 궁금증 되던지는 질문 / 담백한 직접 권유 중 하나를 골라 섞어라.
${perf ? '\n' + perf + '\n' : ''}
[형식 — 반드시]
- 카드 ${min}~${max}장(위 [길이] 예산 우선 — ${min}장으로 되면 ${min}장). 각 카드:
  { "caption": 화면 큰 자막 한 줄(18자 이내),
    "narration": 위 '더빙 자연스러움'·'TTS 친화'·'반복 금지'·'길이' 규칙을 지킨 구어체(카드당 ${lo}~${hi}음절),
    "image_prompt": 이 카드 배경 AI 이미지 영어 프롬프트,
    "footage_keywords": 이 카드 배경에 어울리는 실사 스톡영상 검색용 **영어 키워드 2~4개**(쉼표 없이 공백 구분, 예: "night sky stars galaxy"). 한국어 금지 — 스톡은 영어로만 검색됨. 구체적 사물/장면 위주(추상어 지양). }
- 흐름: ${flow}
- ${hookInstr}
- "hook_image_prompt": 훅 배경용 영어 이미지 프롬프트(시네마틱 히어로 컷).
- "hook_footage_keywords": 훅 배경용 영어 스톡영상 키워드(선택).
- "cta": 마지막 성우 한 줄(${CTA_SYL[0]}~${CTA_SYL[1]}음절) — 위 [CTA] 규칙을 지킨, 소재 밀착·매번 다른 형태의 마무리.
- image_prompt 규칙: 영어, 시네마틱 배경, 글자·UI 없음(no text), 세로 구도·중앙 여백, 주제를 은유. 톤 통일(짙고 무디한 시네마틱).
- ${factRule}

[출력] JSON 만: { "hook":"...", "hook_image_prompt":"...", "hook_footage_keywords":"...", "cards":[{"caption":"...","narration":"...","image_prompt":"...","footage_keywords":"..."}], "cta":"..." }`;
}

export async function generateScript(item, { cfg } = {}) {
  cfg = cfg || loadConfig();
  // 자가발전 폐루프: evolve 성과 인사이트를 훅·제목 지시에 반영(없으면 무주입).
  // 로드가 주입 여부·항목·표본수를 이 컴포넌트 로그로 남긴다.
  const ins = loadInsights({ logger: log });
  if (!ins) log.info('성과 인사이트 없음 → 기존 대본 프롬프트로 진행(무주입)');
  // claude -p 가 대본 JSON 을 깨뜨리는 일시적 flakiness 대비: 생성+파싱을 한 단위로 재시도.
  // callClaude 자체 재시도는 '호출 실패'용 — 파싱/스키마 실패는 새 생성이라야 회복된다
  // (2026-07-15 실측: 10·12시 슬롯이 이 단계서 죽어 매번 수동 재시도로만 통과).
  const attempts = Math.max(1, Number(cfg.script?.parse_attempts) || 3);
  // 길이 예산 — 프롬프트 압박과 검증이 같은 수를 본다(프롬프트만 바꾸면 LLM 이 또 흘러넘친다).
  const budget = lengthBudget(cfg, item.angle);
  log.info(`길이 예산(${budget.angle}): 목표 ${budget.targetLo}~${budget.targetHi}초 · 총 ${budget.maxSyl}음절 이내(하한 ${budget.minSyl}) · 카드 ${budget.minCards}~${budget.maxCards}장 · 카드당 ${budget.perCardLo}~${budget.perCardHi}음절`);

  const { script: parsed, check: finalChk } = resolveScriptWithBudget({
    generate: (lengthHint) => parseScript(callClaude(buildPrompt(item, cfg, ins, { lengthHint, budget })), cfg),
    budget, cfg, attempts, logger: log,
  });

  const slug = slugify(item.id);
  const out = {
    slug,
    title: item.subject,
    backlink: `https://www.youtube.com/@${cfg.channel?.brand || 'thundo'}`,
    ...parsed,
    // 사후 추적용 — 그날 대본이 어떤 예산으로 어떻게 나왔는지(길이 회귀 감시).
    length: { syllables: finalChk.syllables, est_sec: finalChk.est_sec, budget },
  };
  const dir = workDir(slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'script.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
  return { slug, cards: out.cards.length, est_sec: finalChk.est_sec, script: out };
}

async function main() {
  const raw = process.argv[2];
  if (!raw) { log.error('사용법: script.mjs \'<item-json>\''); process.exit(2); }
  try {
    const r = await generateScript(JSON.parse(raw));
    log.info(`대본: ${r.slug} (${r.cards}카드, ≈${r.est_sec}초)`);
    process.stdout.write(JSON.stringify({ ok: true, slug: r.slug, cards: r.cards, est_sec: r.est_sec }) + '\n');
  } catch (e) {
    log.error(`대본 실패: ${e.message}`);
    process.stdout.write(JSON.stringify({ ok: false, reason: e.message }) + '\n');
    process.exit(2);
  }
}

if (isMainModule(import.meta.url)) main();
