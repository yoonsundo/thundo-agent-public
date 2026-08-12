#!/usr/bin/env node
/**
 * cardnews/factcheck.mjs — 인용 실재 검증 (계획 §3.5, AC-20)
 *
 * 계약: `factCheck(item, {cfg})` → `{verdict, note, source, needs_correction,
 *        corrected_title, corrected_author, machine}`. CLI: stdout JSON.
 *
 * 🔴 **차단권만.** `verdict==='ok'` 가 아니면 그 소재는 제작되지 않는다. `ok` 는 "막을 이유를
 * 못 찾았다"이지 "보증한다"가 아니며, 이 모듈은 어떤 경로로도 통과를 *만들어내지* 않는다.
 *
 * ── 🔴 2026-07-31 재설계: LLM 판정 → **원문 대조** ─────────────────────────────
 * 옛 버티컬은 "관습이 실재하는가"를 LLM 에게 물었다. 이 채널이 묻는 것은 **"이 구절이 이 책에
 * 실재하는가"**이고, 그 질문은 LLM 에게 물으면 안 된다 — 인터넷에는 그 책에 없는데 그 책 것으로
 * 떠도는 문장이 대량으로 있고 모델은 그것들을 함께 학습했다. 출처까지 그럴듯하게 붙여 뱉는
 * 바로 그 능력이 여기서는 위험이다.
 *
 * 그래서 판정을 둘로 나눈다:
 *   1차 — **기계 대조(주 판정)**: `source.fulltext_url` 의 원문 전문을 받아(캐시) 강한 정규화 후
 *          `quote_original` 을 대조한다. **없으면 즉시 `false` 이고 LLM 은 호출되지 않는다.**
 *   2차 — **LLM(보조)**: 기계가 찾은 경우에만, 기계가 볼 수 없는 것만 본다 —
 *          맥락 왜곡(반어·비꼼을 진지한 위로로 옮김) · 출처 라벨(오귀속) · 번역 충실도.
 *
 * ⚠ 단순 grep 은 쓰지 않는다 — 원문이 줄바꿈으로 감겨 있어 **실재 구절도 놓친다**(실측된
 * false negative). 구두점·대소문자·줄바꿈까지 지우는 강한 정규화가 필요하다.
 *
 * 🔴 반환의 `source`·`note` 는 상위(script.mjs)가 `provenance` 로 **반드시 영속화**한다(§5.1).
 * 이게 없으면 테이크다운 런북이 운영자에게 "발행된 게시물"만 쥐여주고 "왜 믿었는가"는
 * 아무 데도 없다. 이 채널에서 그 답은 **원문 URL + 대조 성공**이다.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeLogger } from '../lib/log.mjs';
import { loadConfig, callClaude, extractJson, isMainModule, withBrief } from './lib.mjs';
import { isAllowedFulltextUrl } from './backlog.mjs';
// 🔴 캐시 경로는 **인용 게이트와 공유한다**(`gate-quote.mjs:fulltextCachePath`). 같은 작품을
//    두 곳이 따로 받으면 한 편당 수백 KB 를 두 번 내려받고, 더 나쁘게는 "게이트는 찾았는데
//    팩트체크는 못 찾는" 상태가 생긴다. 경로 규칙을 한 곳에서만 정의해 그 갈림을 없앤다.
import { fulltextCachePath } from './gate-quote.mjs';
import '../lib/force-subscription.mjs';

const log = makeLogger('cardnews/factcheck');

// ── 1차: 원문 대조 ───────────────────────────────────────────────────────────

/**
 * 강한 정규화 — 소문자화 + `[a-z0-9가-힣 ]` 밖은 전부 공백 + 공백 접기.
 * 원문의 줄바꿈·따옴표·엠대시·강세부호가 대조를 깨뜨리지 못하게 한다(양쪽에 같은 변환을
 * 적용하므로 정보 손실이 대칭이다).
 */
export function strongNormalize(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9가-힣 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const KEEP = (c) => (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || (c >= 0xac00 && c <= 0xd7a3);

/**
 * 정규화 + **원문 오프셋 맵**. 대조에 성공했을 때 그 자리의 앞뒤 문맥을 원문에서 떠와야
 * 2차 LLM 이 맥락 왜곡을 판정할 수 있는데, 정규화된 문자열만 있으면 그 자리를 원문에서 못 찾는다.
 */
export function normalizeWithMap(s) {
  const src = String(s ?? '');
  const lower = src.toLowerCase();
  const out = [];
  const map = [];
  let pendingSpace = false;
  for (let i = 0; i < lower.length; i++) {
    const c = lower.charCodeAt(i);
    if (KEEP(c)) {
      if (pendingSpace && out.length) { out.push(' '); map.push(i); }
      pendingSpace = false;
      out.push(lower[i]); map.push(i);
    } else {
      pendingSpace = true;
    }
  }
  return { text: out.join(''), map };
}

/**
 * 원문 캐시 경로 — 인용 게이트와 **같은 파일**을 가리킨다. 원문은 불변이라 만료가 없다.
 * @param {string|object} urlOrSource URL 문자열 또는 소재의 `source` 객체
 */
export function corpusPath(urlOrSource) {
  const source = typeof urlOrSource === 'string' ? { fulltext_url: urlOrSource } : (urlOrSource || {});
  return fulltextCachePath(source);
}

/**
 * 원문 전문 확보(캐시 우선). **동기**다 — `run-cardnews.mjs`(무수정 대상)가 `factCheck` 를
 * 동기 호출하므로 async 로 바꾸면 오케가 Promise 를 판정으로 착각한다. 이 레포의 다른 외부
 * 호출(`callClaude`)도 같은 이유로 `execFileSync` 를 쓴다.
 *
 * @param {object} [opt.deps] `{fetchText}` — 테스트 주입점(네트워크 0).
 */
export function fetchFullText(url, { cfg = {}, deps = {}, source = null } = {}) {
  const path = corpusPath(source || url);
  if (existsSync(path)) {
    try { return { ok: true, text: readFileSync(path, 'utf8'), cached: true }; }
    catch { /* 캐시가 깨졌으면 다시 받는다 */ }
  }
  // 🔴 테스트·CI 의 하드 스위치. 인용 게이트와 **같은 환경변수**를 본다 — 두 모듈이 서로 다른
  //    이름을 쓰면 "한쪽만 네트워크를 여는" 상태가 생기고, 그건 조용히 새는 구멍이다.
  if (process.env.CARDNEWS_NO_NETWORK === '1' && !deps.fetchText) {
    return { ok: false, error: `캐시 없음 + 네트워크 비활성(CARDNEWS_NO_NETWORK=1): ${url}` };
  }
  const timeoutMs = Number(cfg?.quote?.fulltext_timeout_ms ?? 60000);
  const maxBytes = Number(cfg?.quote?.fulltext_max_bytes ?? 33554432);
  try {
    const text = deps.fetchText
      ? String(deps.fetchText(url))
      : execFileSync('curl', ['-sSL', '--fail', '--retry', '2', '--retry-delay', '1',
        '--max-time', String(Math.ceil(timeoutMs / 1000)), url],
      { encoding: 'utf8', maxBuffer: maxBytes, timeout: timeoutMs + 5000 });
    if (!text || text.length < 1000) return { ok: false, error: `원문이 비었거나 너무 짧다(${text?.length ?? 0}B)` };
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text, 'utf8');
    } catch (e) { log.warn(`원문 캐시 저장 실패(비차단): ${e.message}`); }
    return { ok: true, text, cached: false };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 정규화 후 이 길이 미만인 인용은 대조하지 않는다 — 짧은 조각은 우연히 일치한다. */
export const MIN_NORMALIZED_QUOTE = 20;

/**
 * 🔴 **주 판정.** 구절이 그 책에 실재하는가.
 * @returns {{found:boolean, reason:string, context?:string, url:string, cached?:boolean}}
 */
export function verifyQuote(item, { cfg = {}, deps = {} } = {}) {
  const url = String(item?.source?.fulltext_url || '').trim();
  const quote = String(item?.quote_original || '').trim();
  if (!quote) return { found: false, reason: 'quote-missing', url };
  if (!url) return { found: false, reason: 'fulltext-url-missing', url };
  if (!isAllowedFulltextUrl(url, cfg)) return { found: false, reason: 'fulltext-url-not-allowed', url };

  const nq = strongNormalize(quote);
  if (nq.length < MIN_NORMALIZED_QUOTE) return { found: false, reason: 'quote-too-short', url };

  const got = fetchFullText(url, { cfg, deps, source: item?.source });
  // 원문을 못 받은 것은 "가짜"가 아니라 "확인 못 함"이다 — 두 사유를 섞으면 네트워크 사고가
  // 소재 날조로 기록된다.
  if (!got.ok) return { found: false, reason: 'corpus-unavailable', url, error: got.error };

  const { text: nt, map } = normalizeWithMap(got.text);
  const at = nt.indexOf(nq);
  if (at === -1) return { found: false, reason: 'quote-not-found', url, cached: got.cached };

  // 대조 성공 → 원문에서 그 자리의 앞뒤를 떠 2차 LLM 에 넘긴다.
  const span = Number(cfg?.quote?.context_chars ?? 400);
  const from = map[at] ?? 0;
  const to = map[Math.min(map.length - 1, at + nq.length - 1)] ?? from;
  const context = got.text.slice(Math.max(0, from - span), Math.min(got.text.length, to + span))
    .replace(/\s+/g, ' ').trim();
  return { found: true, reason: 'quote-found', url, cached: got.cached, context, offset: from };
}

// ── 2차: LLM(보조) ───────────────────────────────────────────────────────────

const CORRECTION_RULE = `
[정정 규칙 — 반드시 지켜라]
- 🔴 **구절과 번역은 정정 대상이 아니다.** 인용을 고쳐 쓰는 것은 새 날조를 만드는 일이다.
  구절이 맥락과 어긋나거나 번역이 원문의 뜻을 바꿨다면 needs_correction 이 아니라 **doubtful 이하**로 막아라.
- 정정할 수 있는 것은 **제목·저자 라벨뿐**이다. 구절이 실재하는 작품은 기계가 이미 확인했으므로,
  어긋날 수 있는 것은 그 작품에 붙인 이름이다.
- 라벨이 틀렸다면 needs_correction=true 로 하고 corrected_title·corrected_author 를 **둘 다** 채워라.
- 두 값은 "무엇을 고쳐라"는 지시문이 아니라 **그대로 쓸 수 있는 정정된 값**이어야 한다.
- 고칠 게 없으면 needs_correction=false, 두 필드는 빈 문자열로 둬라.
- ⚠ note 에만 "수정 필요"라고 적고 값을 비워 두면 그 소재는 **발행되지 않고 폐기**된다.`;

/** 구형·부실 응답에서 "정정 요구"를 읽어내는 신호. 애매하면 막는 쪽. */
export const CORRECTION_SIGNALS = [
  /반드시\s*(수정|정정|교정)/,
  /(수정|정정|교정)\s*(이\s*)?(반드시|필요|해야|할\s*것)/,
  /사실과\s*다르/,
  /틀렸|틀림|오류/,
  /오귀속|잘못\s*알려진\s*(저자|출처)/,
  /(저자|작가|제목|출처)\s*(가|는|이)?\s*(다르|아님|아니)/,
];

export function noteDemandsCorrection(note) {
  const s = String(note || '');
  return CORRECTION_SIGNALS.some(re => re.test(s));
}

/**
 * note 가 **구절·번역·맥락**의 문제를 지목했는가 — 이 경우 정정으로 해결되지 않는다.
 * 라벨 정정으로 덮고 넘어가면 왜곡된 인용이 라벨만 바뀐 채 그대로 나간다.
 */
export function noteFlagsQuote(note) {
  return /구절|인용|문장|번역|맥락|왜곡|반어|비꼬|원문/.test(String(note || ''));
}

const usableText = (v) => {
  const s = String(v ?? '').trim();
  if (!s || s.length > 200) return '';
  if (/^(수정|정정|교정|없음|해당\s*없음|n\/?a)$/i.test(s)) return '';
  if (/(수정|정정|교정)\s*(할\s*것|필요|요망)/.test(s)) return '';
  return s;
};

/**
 * LLM 응답 → 정규화된 판정.
 *
 * **미지의 verdict 는 `doubtful` 로 떨어진다**(`ok` 가 아니다). 모델이 필드를 빠뜨리거나
 * 오타를 내는 것이 통과 사유가 되면 안 된다.
 * 그리고 verdict=ok 인데 note 가 강한 정정을 요구하면 needs_correction 을 **끌어올린다**
 * (US-010: 팩트체커가 note 에 "반드시 수정할 것"이라 적었는데 verdict 가 ok 라서 기계가
 * 못 읽고 발행한 실사고 — 정정 문장이 없으면 `applyCorrection` 이 보류시킨다).
 */
export function normalizeFactcheck(obj = {}) {
  const verdict = ['ok', 'doubtful', 'false'].includes(obj?.verdict) ? obj.verdict : 'doubtful';
  const note = String(obj?.note || '');
  const corrected_title = usableText(obj?.corrected_title);
  const corrected_author = usableText(obj?.corrected_author);
  const hasField = typeof obj?.needs_correction === 'boolean';
  const inferred = noteDemandsCorrection(note);
  const needs_correction = (hasField ? obj.needs_correction : false) || inferred;
  return {
    verdict, note, source: String(obj?.source || ''),
    needs_correction, corrected_title, corrected_author,
    correction_inferred: !hasField && inferred,
    machine: obj?.machine ?? null,
    machine_reason: obj?.machine_reason ?? null,
  };
}

/**
 * 정정 반영 — 정정본이 `source.title`·`source.author` 를 **대체**해 대본·캡션까지 흘러간다.
 * 적용 불가면 `applied=false` → 호출자는 발행하지 말고 보류해야 한다.
 */
export function applyCorrection(item, fc = {}) {
  if (!fc.needs_correction) return { applied: true, changed: false, item, reason: 'no_correction_needed' };
  // 🔴 구절·번역·맥락 문제는 라벨 정정으로 덮지 않는다 — 그건 왜곡을 이름만 바꿔 내보내는 것이다.
  if (noteFlagsQuote(fc.note)) return { applied: false, changed: false, item, reason: 'quote_not_correctable' };
  const ct = usableText(fc.corrected_title);
  const ca = usableText(fc.corrected_author);
  if (!ct || !ca) return { applied: false, changed: false, item, reason: 'correction_missing' };
  const sameTitle = ct === String(item?.source?.title || '').trim();
  const sameAuthor = ca === String(item?.source?.author || '').trim();
  if (sameTitle && sameAuthor) return { applied: false, changed: false, item, reason: 'correction_identical' };
  return {
    applied: true, changed: true, reason: 'corrected',
    item: {
      ...item,
      source: { ...item?.source, title: ct, author: ca },
      factcheck_corrected: true,
      original_source: item?.source ?? null,
    },
  };
}

/**
 * 판정 1건 → 제작/보류 결정(3갈래).
 *  ① verdict≠ok                    → hold
 *  ② ok + 정정필요 + 정정본 있음    → 정정 반영 후 제작
 *  ③ ok + 정정필요 + 정정 불가      → hold (알려진 오류를 내보내지 않는다)
 *
 * `held_reason` 을 `factcheck:` 접두로 유지한다 — `classifyHeld` 가 이 접두를 보고
 * `permanent` 로 분류하고(재시도해도 같은 결과), 1-A 집계에서 면제되지 않는다.
 * 접두 뒤에는 **기계 사유**를 싣는다(`quote-not-found` / `corpus-unavailable`) — 원인이
 * 날조인지 네트워크인지 구분되지 않으면 다음 조정이 추측이 된다.
 */
export function resolveFactcheck(item, fc = {}) {
  if (fc.verdict !== 'ok') {
    const why = fc.machine_reason || fc.verdict;
    return { action: 'hold', item, reason: `factcheck:${why}`, note: fc.note || '', log: `인용검증 ${fc.verdict}(${why})` };
  }
  const corr = applyCorrection(item, fc);
  if (!corr.applied) {
    return {
      action: 'hold', item,
      reason: 'factcheck:correction-unapplicable',
      note: `정정 적용 불가(${corr.reason}) :: ${fc.note || ''}`,
      log: `인용검증 ok 이나 정정 적용 불가(${corr.reason}) — 알려진 오류 발행 방지`,
    };
  }
  return { action: 'produce', item: corr.item, corrected: corr.changed, reason: 'ok', note: fc.note || '', log: 'ok' };
}

export function buildPrompt(item, verify = {}) {
  const src = item?.source || {};
  return withBrief('hedgehog', `아래 인용은 **기계가 원문 전문에서 이미 찾아냈다**(대조 성공). 실재 여부는 다시 판정하지 말고, 기계가 볼 수 없는 것만 판정하라.

문제: ${item?.problem ?? ''}
상황: ${item?.situation ?? ''}
원문 구절: ${item?.quote_original ?? ''}
우리 번역: ${item?.quote_ko ?? ''}
출처: ${src.title ?? ''} · ${src.author ?? ''} (${src.year ?? '연도미상'}) · form=${item?.form ?? ''}
원문 주소: ${src.fulltext_url ?? ''}
우리 해설: ${item?.interpretation ?? ''}

[원문에서 그 구절이 놓인 자리 — 앞뒤 문맥]
${verify.context || '(문맥을 뜨지 못했다 — 이 경우 맥락 판정을 보수적으로 하라)'}

[반드시 확인]
① **맥락 왜곡** — 위 문맥에서 그 구절의 뜻과 우리가 쓰려는 뜻이 반대가 아닌가. 고전에는 화자가 비꼬는 말,
   나중에 틀린 것으로 드러나는 인물의 단언, 반어로 쓰인 문장이 많다. 그런 문장을 진지한 위로로 옮기면
   실재하는 구절을 쓴 거짓말이 된다.
② **출처 라벨** — 제목·저자가 그 작품이 맞는가. 널리 퍼진 오귀속(다른 사람 말인데 유명 작가 것으로 도는 문장,
   역자 서문·편집자 해설을 본문으로 아는 경우)을 특히 의심하라.
③ **번역 충실도** — 우리 번역이 원문의 뜻을 늘리거나 줄이거나 뒤집지 않았는가. 원문에 없는 위로를 번역에
   얹었다면 doubtful.
④ **해설이 구절을 넘어서지 않는가** — 해설은 우리 말이어도 되지만, 작가가 하지 않은 주장을 작가의 것으로
   돌리면 안 된다.

⚠ **인용 날조·사람 일반화·치료 조언 금지, 원문에서 확인된 문장만.** 구절이 실재하더라도 카드가 성별·연령·유형으로
사람을 묶거나 진단·치료·처방으로 읽히면 doubtful 이하로 막아라.

🔴 **비대칭**: 위로 한 편을 거르면 그날 하루가 빈다. 왜곡된 인용 한 건이 나가면 계정의 정체성이 끝나고,
인스타그램에는 삭제 API 가 없다. 두 비용은 비교 대상이 아니다. **확신이 없으면 doubtful.**

[출력] JSON 객체만:
{ "verdict": "ok" | "doubtful" | "false",
  "note": 한 줄 근거/이유,
  "source": 확인에 쓴 근거(원문 주소·문맥. 없으면 빈문자열),
  "needs_correction": true|false,
  "corrected_title": 정정된 제목,
  "corrected_author": 정정된 저자 }
- ok: 맥락이 맞고 출처 라벨이 정확하며 번역이 충실함.
- doubtful: 맥락이 애매하거나 번역이 원문을 넘어서거나 확신이 서지 않음.
- false: 맥락이 반대이거나 출처가 그 작품이 아님.
${CORRECTION_RULE}`);
}

/** 기계 대조 실패 → LLM 없이 즉시 판정. 사유별로 verdict 가 갈린다. */
const MACHINE_FAIL = {
  'quote-not-found': { verdict: 'false', note: '원문 대조 실패 — 그 구절이 원문에 없다(날조·의역·기억 재구성)' },
  'quote-missing': { verdict: 'doubtful', note: '원문 구절(quote_original)이 비어 대조할 수 없다' },
  'quote-too-short': { verdict: 'doubtful', note: `정규화 후 ${MIN_NORMALIZED_QUOTE}자 미만 — 짧은 조각은 우연히 일치한다` },
  'fulltext-url-missing': { verdict: 'doubtful', note: '원문 주소(source.fulltext_url)가 없어 대조할 수 없다' },
  'fulltext-url-not-allowed': { verdict: 'doubtful', note: '원문 주소가 허용 호스트 밖 — 대조 소스를 신뢰할 수 없다' },
  'corpus-unavailable': { verdict: 'doubtful', note: '원문을 받지 못해 대조하지 못했다(확인 실패이지 날조 판정이 아니다)' },
};

/**
 * 소재 1건 인용 검증. **claude 호출 실패는 throw 한다** — 검증이 안 돌았는데 통과로 처리하는
 * 경로를 만들지 않는 것이 차단권만 가진 단계의 유일한 안전 설계다(fail-closed).
 * 단 1차(기계 대조)에서 막힌 건은 claude 를 아예 부르지 않으므로 토큰도 쓰지 않는다.
 */
export function factCheck(item, { cfg = null, deps = {} } = {}) {
  const conf = cfg || loadConfig();
  if (conf.factcheck?.enabled === false) {
    log.warn('factcheck.enabled=false — 검증 없이 통과시키지 않고 doubtful 로 막는다');
    return normalizeFactcheck({ verdict: 'doubtful', note: 'factcheck.enabled=false (검증 비활성)', machine_reason: 'disabled' });
  }

  // ── 1차: 기계 대조(주 판정) ────────────────────────────────────────────────
  const verify = verifyQuote(item, { cfg: conf, deps });
  if (!verify.found) {
    const f = MACHINE_FAIL[verify.reason] || { verdict: 'doubtful', note: `원문 대조 실패(${verify.reason})` };
    log.warn(`인용검증 [${f.verdict}] ${verify.reason} — ${item?.problem ?? ''}`);
    return normalizeFactcheck({
      verdict: f.verdict,
      note: `${f.note}${verify.error ? ` :: ${verify.error}` : ''}`,
      source: verify.url || '',
      machine_reason: verify.reason,
      machine: { verified: false, reason: verify.reason, url: verify.url || null },
    });
  }

  // ── 2차: LLM(보조) — 맥락·라벨·번역만 ─────────────────────────────────────
  const call = deps.callClaude || callClaude;
  const raw = extractJson(call(buildPrompt(item, verify), { cfg: conf }));
  const fc = normalizeFactcheck({
    ...raw,
    // 근거의 최종 형태는 **원문 URL** 이다 — 테이크다운 런북이 손에 쥐는 것이 이것이다.
    source: String(raw?.source || '').trim() || verify.url,
    machine_reason: null,
    machine: { verified: true, url: verify.url, offset: verify.offset ?? null, cached: Boolean(verify.cached) },
  });
  log.info(`인용검증 [${fc.verdict}] ${item?.problem ?? ''}${fc.needs_correction ? ' (라벨 정정요구)' : ''}`);
  return fc;
}

function main() {
  try {
    const raw = process.argv[2];
    if (!raw) { process.stderr.write('사용법: factcheck.mjs \'<BacklogItem JSON>\'\n'); process.exit(2); }
    const item = JSON.parse(raw);
    const fc = factCheck(item);
    process.stdout.write(JSON.stringify({ ok: true, ...fc, resolution: resolveFactcheck(item, fc) }) + '\n');
    process.exit(0);
  } catch (e) {
    log.error(`인용검증 실패: ${e.message}`);
    process.stdout.write(JSON.stringify({ ok: false, error: e.message, diag: e.diag || null }) + '\n');
    process.exit(2);
  }
}

if (isMainModule(import.meta.url)) main();
