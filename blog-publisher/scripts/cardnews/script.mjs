#!/usr/bin/env node
/**
 * cardnews/script.mjs — Robin 🐦 대본 + 예비 대본 buffer (계획 §3.6)
 *
 * 계약: `generateScript(item, {cfg})` → 대본 JSON + `state/cardnews/work/{post_id}/script.json`.
 *
 * 스키마: cover(1) + cards(`cards.body_count`, 기본 5) + outro(1) = 기본 **7**. AC-4 의 "7장"이
 * 렌더가 아니라 **스키마 수준에서** 보장된다 — 렌더에서 세는 것보다 여기서 막는 것이 싸고,
 * Playwright·Supabase 비용을 태우기 전에 실패한다.
 *
 * 🔴 **버티컬 전환(2026-07-31)**: 카드 역할이 (자극→유용→반전)에서
 * **(문제 지목 → 공감 → 책의 말 → 해석 → 전환 → 저장·지목)** 으로 갈렸다. 옛 역할표·문형표는
 * `script.mjs.worldculture.bak` 에 있다.
 *
 * 🔴 **인용은 손대지 않는다.** 대본이 `quote_ko` 를 다듬는 순간 원문 대조로 얻은 보증이 무효가
 * 된다. 그래서 인용·출처를 구조화 필드(`quote`)로도 함께 내보내게 하고 검증에서 강제한다 —
 * 인용 게이트(`gate-quote.mjs`)가 카드 본문에서 문자열을 되짚는 것보다, 작가가 무엇을 인용했다고
 * 주장하는지를 명시적으로 받는 편이 확인 가능하다.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { makeLogger } from '../lib/log.mjs';
import {
  loadConfig, callClaude, extractJson, isMainModule, withBrief, workDir, bufferDir, transition,
} from './lib.mjs';
import '../lib/force-subscription.mjs';

const log = makeLogger('cardnews/script');

/** 기본 본문 장수 — config 가 없거나 값이 이상할 때의 폴백. cover(1)+5+outro(1)=7 (AC-4). */
export const BODY_CARDS = 5;

/** 허용 범위 — 3 미만은 역할 배치(공감/인용/해석/전환)가 성립하지 않고, 7 초과는 캐러셀 이탈이 커진다. */
export const BODY_CARDS_MIN = 3;
export const BODY_CARDS_MAX = 7;

/**
 * 본문 장수 — **config `cards.body_count` 가 진실이다.**
 * 범위를 벗어난 값은 throw 하지 않고 클램프한다: 설정 오타로 그날 발행을 날리는 것보다
 * 기본값으로 돌면서 경고를 남기는 편이 낫다.
 * ⚠ `gates.expected_count` 는 손으로 맞춰야 한다(= body_count + 2).
 */
export function bodyCardCount(cfg = {}) {
  const raw = cfg?.cards?.body_count;
  if (raw == null) return BODY_CARDS;
  const n = Number(raw);
  if (!Number.isInteger(n)) { log.warn(`cards.body_count=${raw} 가 정수가 아니다 → ${BODY_CARDS} 사용`); return BODY_CARDS; }
  if (n < BODY_CARDS_MIN || n > BODY_CARDS_MAX) {
    const c = Math.min(BODY_CARDS_MAX, Math.max(BODY_CARDS_MIN, n));
    log.warn(`cards.body_count=${n} 이 허용 범위(${BODY_CARDS_MIN}~${BODY_CARDS_MAX}) 밖 → ${c} 로 클램프`);
    return c;
  }
  return n;
}

/**
 * 카드 자리 계산(전체 번호 기준: 1=표지 … T=마무리).
 *
 * 🔴 사양의 역할표(표지=문제 지목 / 1~2=공감 / 3~4=책의 말 / 5=해석 / 6=전환 / 7=저장+지목)를
 * **전체 번호**로 읽으면 정확히 7장에 들어맞는다: 표지가 문제를 지목하면서 공감을 열고(1~2),
 * 3~4가 인용과 출처, 5가 해석, 6이 전환, 7이 마무리다. 8장으로 읽으면 `gates.expected_count`
 * 와 벤치마크 픽스처가 함께 어긋나므로 이 해석을 채택한다(보고서에 명시).
 */
export function cardLayout(n = BODY_CARDS) {
  const total = n + 2;
  const outro = total;
  const twist = total - 1;                                   // 전환
  const quoteStart = 3;
  const quoteEnd = Math.min(4, Math.max(quoteStart, total - 3));
  const interpStart = quoteEnd + 1;
  const interpEnd = total - 2;
  return { total, cover: 1, empathy: 2, quoteStart, quoteEnd, interpStart, interpEnd, twist, outro };
}

// ── 검증 ─────────────────────────────────────────────────────────────────────

const len = (s) => String(s ?? '').trim().length;

/**
 * 대본 스키마·글자수 검증 → `{ok, violations[]}`.
 * 위반을 **모아서** 돌려주는 이유: 재생성 힌트에 전부 실어야 한 번에 고쳐지고, 한 건씩
 * 알려주면 3회 시도를 한 필드 고치는 데 다 쓴다.
 */
export function validateScript(script, cfg = {}, { item = null } = {}) {
  const maxH = cfg?.cards?.headline_max_chars ?? 24;
  const maxB = cfg?.cards?.body_max_chars ?? 90;
  const maxQ = cfg?.quote?.max_chars ?? 120;
  const v = [];

  if (!script || typeof script !== 'object') return { ok: false, violations: ['대본이 객체가 아니다'] };

  if (!script.cover || !len(script.cover.headline)) v.push('cover.headline 없음');
  else if (len(script.cover.headline) > maxH) v.push(`cover.headline ${len(script.cover.headline)}자 > ${maxH}자`);
  if (script.cover && len(script.cover.sub) > 34) v.push(`cover.sub ${len(script.cover.sub)}자 > 34자`);
  // 🔴 `country` 는 렌더러의 pill 슬롯이다(`render.mjs` 가 이 키를 모든 카드에 그린다 — 엔진
  //    무수정 대상이라 키 이름을 바꾸지 않는다). 이 채널에서 그 자리에 들어가는 것은 **책 제목**이고,
  //    그래서 7장 내내 출처가 화면에 남는다.
  if (!script.cover || !len(script.cover.country)) v.push('cover.country(책 제목 pill) 없음');
  else if (len(script.cover.country) > 20) v.push(`cover.country ${len(script.cover.country)}자 > 20자 (pill 넘침)`);

  const want = bodyCardCount(cfg);
  const cards = Array.isArray(script.cards) ? script.cards : [];
  if (cards.length !== want) v.push(`cards ${cards.length}장 ≠ ${want}장 (표지·마무리 제외)`);
  cards.forEach((c, i) => {
    const n = c?.index ?? i + 1;
    if (!len(c?.headline)) v.push(`cards[${n}].headline 없음`);
    else if (len(c.headline) > maxH) v.push(`cards[${n}].headline ${len(c.headline)}자 > ${maxH}자`);
    if (!len(c?.body)) v.push(`cards[${n}].body 없음`);
    else if (len(c.body) > maxB) v.push(`cards[${n}].body ${len(c.body)}자 > ${maxB}자`);
  });

  if (!script.outro || !len(script.outro.headline)) v.push('outro.headline 없음');
  else if (len(script.outro.headline) > maxH) v.push(`outro.headline ${len(script.outro.headline)}자 > ${maxH}자`);
  if (script.outro && len(script.outro.body) > maxB) v.push(`outro.body ${len(script.outro.body)}자 > ${maxB}자`);

  // 🔴 인용 블록 — 프롬프트로 요구만 하면 조용히 빠진다. 빠지면 인용 게이트가 무엇을 검사해야
  //    하는지 모르게 되고, 출처 없는 감성글이 그대로 나간다(그건 이 채널의 정체성 자체다).
  const q = script.quote;
  if (!q || typeof q !== 'object') v.push('quote 블록 없음(인용 원문·출처)');
  else {
    if (!len(q.text)) v.push('quote.text 없음');
    else if (len(q.text) > maxQ) v.push(`quote.text ${len(q.text)}자 > ${maxQ}자`);
    if (!len(q.source?.title)) v.push('quote.source.title 없음');
    if (!len(q.source?.author)) v.push('quote.source.author 없음');
    // 🔴 번역자는 **키의 존재**로 계약한다 — 우리는 원문에서 직접 옮기므로 항상 null 이고,
    //    키 누락(모름)과 null(자체 번역)은 다르게 판정돼야 한다.
    if (!q.source || !('translator' in q.source)) v.push('quote.source.translator 키 없음(자체 번역이면 null 을 명시)');
    else if (q.source.translator !== null) v.push('quote.source.translator 는 null 이어야 한다(기존 번역서 사용 금지)');

    // 🔴 인용 불가침 — 대본이 인용을 "다듬으면" 원문 대조로 얻은 보증이 무효가 된다.
    //    프롬프트로 부탁만 하면 모델은 리듬을 맞추려고 한두 글자를 고친다(그게 작가의 본능이다).
    //    소재를 함께 받은 경우에는 기계가 대조해 막는다.
    if (item) {
      if (len(item.quote_ko) && String(q.text ?? '').trim() !== String(item.quote_ko).trim()) {
        v.push('quote.text 가 검증된 인용(quote_ko)과 다르다 — 인용은 한 글자도 바꾸지 않는다');
      }
      for (const [k, label] of [['title', '제목'], ['author', '저자']]) {
        if (len(item.source?.[k]) && String(q.source?.[k] ?? '').trim() !== String(item.source[k]).trim()) {
          v.push(`quote.source.${k} 가 검증된 출처(${label})와 다르다`);
        }
      }
    }
  }

  for (const k of ['hook', 'body', 'cta']) {
    if (!len(script.caption_sections?.[k])) v.push(`caption_sections.${k} 없음`);
  }
  if (!Array.isArray(script.hashtags) || !script.hashtags.length) v.push('hashtags 없음');

  return { ok: v.length === 0, violations: v };
}

/**
 * 대본에 실어 보내는 **검증된 인용 필드**. 인용 게이트가 `script.item` 에서 이 모양을 읽는다
 * (`gate-quote.mjs:extractQuoteFields` — `obj.item` 후보). 소재 원본에서 그대로 복사하며,
 * 모델을 거치지 않는다.
 */
export function quoteFieldsOf(item = {}) {
  return {
    quote_ko: item?.quote_ko ?? null,
    quote_original: item?.quote_original ?? null,
    interpretation: item?.interpretation ?? null,
    form: item?.form ?? null,
    source: item?.source ?? null,
    public_domain: item?.public_domain ?? null,
  };
}

/** 총 카드 수 — 스키마가 7을 보장하는지 한 눈에 세는 헬퍼(게이트·테스트 공용). */
export function cardCount(script) {
  return (script?.cover ? 1 : 0) + (Array.isArray(script?.cards) ? script.cards.length : 0) + (script?.outro ? 1 : 0);
}

// ── 프롬프트 ─────────────────────────────────────────────────────────────────

/**
 * 카드 역할표 — 자리마다 **다른 일**을 시킨다. 번호는 **전체 카드 기준**이다.
 *
 * 🔴 이 채널의 실패는 자극이 없어서가 아니라 **아무 말도 안 해서**다. 그래서 마지막 본문
 * (전환)이 "힘내세요"로 끝나는 것을 이름 불러 금지한다 — 게이트가 잡을 수 없는 종류의
 * 실패이고, 잡히지 않는 실패는 프롬프트에서 막는 수밖에 없다.
 */
export function cardRoles(n = BODY_CARDS) {
  const L = cardLayout(n);
  const quote = L.quoteStart === L.quoteEnd ? `${L.quoteStart}번 카드` : `${L.quoteStart}~${L.quoteEnd}번 카드`;
  const interp = L.interpStart > L.interpEnd
    ? `(해석은 ${L.quoteEnd}번 카드 뒤쪽에서 이어 붙여라)`
    : (L.interpStart === L.interpEnd ? `${L.interpStart}번 카드` : `${L.interpStart}~${L.interpEnd}번 카드`);
  return `[카드 역할 — 자리마다 하는 일이 다르다. 같은 일을 두 장에 시키지 마라]
- **1번(표지) = 문제 지목.** 읽는 사람이 겪고 있는 상태를 한 줄로 부른다("내가 너무 많이 준 것 같을 때").
  해결도 위로도 아직 하지 마라. 지목만으로 멈추게 하는 자리다.
- **2번 카드 = 공감.** 그 상황을 **구체적인 장면**으로 적어라. "힘들죠" 같은 요약이 아니라, 읽는 사람이
  "이거 내 얘기다" 하게 만드는 한 장면. 여기까지가 문제의 자리다 — 아직 책을 꺼내지 마라.
- **${quote}(책의 말) = 이 채널의 정체성.** 주어진 인용을 **한 글자도 바꾸지 말고** 그대로 싣고,
  **제목·저자를 반드시 노출하라**(출처 없는 감성글과 우리를 가르는 유일한 선이다).
  두 장이면 앞장이 구절, 뒷장이 출처와 그 구절이 놓인 자리다.
- **${interp}(해석) = 분량상 주(主).** 그 구절이 **지금 이 상황에서** 무슨 뜻인지 우리 말로 푼다.
  인용은 고전 그대로지만 해석은 **오늘의 말**이어야 한다 — 번역체를 흉내 내면 낭독이 되고 위로가 아니다.
- **${L.twist}번 카드 = 전환.** 관점이 실제로 하나 뒤집힌다.
  🔴 "결국 다 지나간다", "당신은 충분해요", "힘내세요"로 끝나면 아무도 저장하지 않는다.
  **"더 노력하라"가 아니라 "그건 노력의 문제가 아니었다"** 쪽으로 뒤집어라. 읽는 사람이 자신을 탓하던
  자리에서 한 걸음 옆으로 옮겨 서게 만드는 것, 그게 전환이다.
- **${L.outro}번 카드(마무리) = 저장 + 지목.** 이 글을 보낼 사람을 이름 불러 지목하라("요즘 지쳐 보이는 사람에게").
  한국 인스타에서 공유는 대부분 1:1 DM 전달이고, 전달하려면 **보낼 사람이 지목돼야** 한다.
  그리고 **저장**을 명시적으로 요청하라.`;
}

/**
 * 문형 대조표 — 이 채널에서 막아야 할 축은 **성별·연령·유형(MBTI 등)** 이다.
 * (옛 버티컬의 국명 축과 문형이 같다: `"○○ 사람들은 다 ~"` → `"여자들은 다 ~"`.)
 *
 * 왼쪽은 전부 단정적이다 — 헤징하라는 뜻이 아니라, 주어를 **사람의 집단이 아니라 상황·행동**으로
 * 잡으라는 뜻이다.
 */
export const SENTENCE_TABLE = `[문형 — 왼쪽으로만 써라]
| 써도 되는 문형 | 쓰면 안 되는 문형 |
|---|---|
| 먼저 연락하는 쪽이 늘 정해져 있으면 관계는 기운다. | 여자들은 다 먼저 연락받고 싶어 한다. |
| 거절을 미루면 미안함은 이자가 붙는다. | 착한 사람들은 원래 거절을 못 한다. |
| 혼자 있는 시간이 줄면 마음은 먼저 지친다. | INFP 는 원래 혼자 있어야 충전된다. |
| [상황]에서는 [행동]이 마음을 깎는다. | [집단]은 다 [성향]이다. |
| [행동]은 [감정]을 미루는 방식이다. | [나이대]는 원래 [태도]다. |

왼쪽은 전부 단정적이다. **약하게 쓰라는 뜻이 아니다** — 주어를 사람의 집단이 아니라 상황·행동으로
잡으라는 뜻이다. 그렇게 잡으면 세게 써도 된다.`;

/**
 * 후퇴성 헤징·훈계 금지 — 게이트가 못 잡는 종류의 실패라서 이름을 불러 막는 수밖에 없다.
 */
export const HEDGE_BAN = `[후퇴하지 마라 · 훈계하지 마라 — 아래 표현은 금지]
"결국 다 지나간다", "사람마다 다르다", "정답은 없다", "힘내세요", "긍정적으로 생각하세요".
앞의 셋은 어떤 게이트에도 걸리지 않으면서 카드를 아무 말도 하지 않은 것으로 만들고,
뒤의 둘은 위로가 아니라 지시다 — 지친 사람에게 지시는 짐을 하나 더 얹는 일이다.
범위를 좁힐 필요가 있으면 두루뭉술하게 물러나지 말고 **정확히** 좁혀라("일주일째 먼저 연락하지 않았다면").`;

/** 표지 문구 패턴 5종 — 전부 24자 이내·사람 집단을 주어로 삼지 않는 형태. */
export const COVER_PATTERNS = `[표지 headline — 아래 5가지 중에서 골라 써라]
1. \`내가 [행동]한 것 같을 때\`          예) 내가 너무 많이 준 것 같을 때
2. \`[상황]이 자꾸 [감정]로 남을 때\`     예) 대화가 자꾸 후회로 남을 때
3. \`[행동]을 못 하는 게 [통념]은 아니다\` 예) 거절 못 하는 게 착한 건 아니다
4. \`[감정]이 오래 가는 이유\`            예) 헤어진 뒤 자책이 오래 가는 이유
5. \`[대상]에게 아직 못 한 말\`           예) 떠난 사람에게 아직 못 한 말`;

export function buildScriptPrompt(item, cfg = {}, hint = '') {
  const maxH = cfg?.cards?.headline_max_chars ?? 24;
  const maxB = cfg?.cards?.body_max_chars ?? 90;
  const maxQ = cfg?.quote?.max_chars ?? 120;
  const n = bodyCardCount(cfg);
  const L = cardLayout(n);
  const src = item?.source || {};
  const opt = (label, v) => (String(v || '').trim() ? `${label}: ${String(v).trim()}\n` : '');
  return withBrief('robin', `아래 검증된 소재로 인스타 카드뉴스 대본을 만들어라.

문제: ${item?.problem ?? item?.subject ?? ''}
상황: ${item?.situation ?? ''}
🔴 인용(그대로 쓸 것): ${item?.quote_ko ?? ''}
출처: ${src.title ?? ''} · ${src.author ?? ''}${src.year ? ` (${src.year})` : ''}
${opt('원문', item?.quote_original)}${opt('해설 재료', item?.interpretation)}${opt('전환 재료', item?.shift)}${opt('보낼 사람', item?.audience)}
[🔴 인용은 손대지 마라]
위 인용은 기계가 원문 전문에서 **글자 단위로 대조해 실재를 확인한** 문장이다. 줄이거나 다듬거나
매끄럽게 고치는 순간 그 확인은 무효가 된다. 카드에도, quote.text 에도 **그대로** 옮겨라.
출처(제목·저자)는 ${L.quoteStart}~${L.quoteEnd}번 카드에 **반드시 노출**한다.

[이 글의 목적 — **저장**]
사람이 위로 카드를 저장하는 이유는 셋뿐이다: ①그 상황이 또 올 때 다시 꺼내 보려고
②누군가에게 보내려고 ③자기를 탓하던 자리에서 옮겨 서게 해 줘서. 이 대본은 그중 최소 하나를
분명히 만족해야 한다. 다 읽고도 저장할 이유가 없으면, 문장이 아무리 고와도 실패한 대본이다.

[구조 — 고정]
표지 1장 + 본문 ${n}장 + 마무리 1장 = 정확히 ${L.total}장. 늘리거나 줄이지 마라.

${cardRoles(n)}

[글자수 — 초과하면 렌더에서 잘린다]
- 모든 headline: ${maxH}자 이내
- 모든 body: ${maxB}자 이내
- cover.sub: 34자 이내
- quote.text: ${maxQ}자 이내

${COVER_PATTERNS}

${SENTENCE_TABLE}

${HEDGE_BAN}

[문구 규칙]
- **인용 날조·사람 일반화·치료 조언 금지, 원문에서 확인된 문장만.** 주어는 상황·행동·감정이지 사람의 집단이 아니다.
- 전칭 부사(다·모두·전부·항상·원래·하나같이), 유형 단정(MBTI·별자리·혈액형), 성별·나이대 일반화 금지.
- **진단하지 마라.** 우울·불안·번아웃을 상태로 규정하거나 무엇을 하라고 처방하지 않는다. 이 카드는 치료가 아니다.
- 캡션 hook 은 더보기 전에 보이는 첫 두 줄이다. 해시태그는 주제와 실제로 관련된 것만.
- 캡션 cta 에도 **저장**을 요청하라.
${hint ? `\n${hint}\n` : ''}
[출력] JSON 객체만:
{ "cover": { "headline": "…", "sub": "…", "country": "${(src.title ?? '').slice(0, 20)}", "flag_emoji": "📖" },
  "cards": [ { "index": 1, "headline": "…", "body": "…" }, … 정확히 ${n}개 ],
  "outro": { "headline": "…", "body": "…" },
  "quote": { "text": "${item?.quote_ko ?? ''}",
             "source": { "title": "${src.title ?? ''}", "author": "${src.author ?? ''}", "translator": null, "year": ${Number.isFinite(Number(src.year)) ? Number(src.year) : 'null'} } },
  "caption_sections": { "hook": "…", "body": "…", "cta": "…" },
  "hashtags": ["#책속의문장", "…"] }
⚠ cover.country 는 렌더러가 모든 카드에 그리는 라벨 자리다 — **책 제목**(20자 이내)을 넣어라.
⚠ quote.source.translator 는 **null 고정**이다(우리가 원문에서 직접 옮겼다).
설명 없이 JSON 만.`);
}

// ── 생성 ─────────────────────────────────────────────────────────────────────

/**
 * 검증을 통과하는 대본을 확보한다 — 생성기를 주입받는 순수 제어 로직(테스트 가능).
 *
 * ①통과하면 즉시 채택 ②위반이면 **위반 목록을 힌트로 붙여** 재생성 ③시도를 다 쓰면 throw.
 * 폴백 채택(초과분 그대로 통과)은 없다: 카드 글자수 초과는 이미지에서 **잘려 보이므로**
 * 발행 공백보다 나쁘다.
 */
export function resolveScript({ generate, cfg, attempts = 3, logger = log, item = null }) {
  const max = Math.max(1, Number(attempts) || 1);
  let lastErr = null, hint = '', last = null;
  for (let i = 1; i <= max; i++) {
    let cand;
    try { cand = generate(hint); }
    catch (e) { lastErr = e; logger.warn(`대본 생성 시도 ${i}/${max} 실패: ${e.message}`); if (e.budget) throw e; continue; }
    const chk = validateScript(cand, cfg, { item });
    if (chk.ok) {
      logger.info(`대본 검증 통과(시도 ${i}/${max}) — 카드 ${cardCount(cand)}장`);
      return { script: cand, attempts_used: i };
    }
    last = chk;
    logger.warn(`대본 검증 실패(시도 ${i}/${max}): ${chk.violations.join(' · ')}`);
    hint = `⚠ 직전 시도는 다음을 어겼다. 이번엔 반드시 고쳐라:\n- ${chk.violations.join('\n- ')}`;
  }
  const why = last ? last.violations.join(' · ') : (lastErr?.message || '알 수 없음');
  const err = new Error(`대본 생성 실패(${max}회 시도): ${why}`);
  err.violations = last?.violations || [];
  throw err;
}

/**
 * 소재 1건 → 대본. `postId` 를 주면 `work/{post_id}/script.json` 에 저장한다.
 */
export function generateScript(item, { cfg = null, deps = {}, postId = null, attempts = 3 } = {}) {
  const conf = cfg || loadConfig();
  const call = deps.callClaude || callClaude;
  const { script, attempts_used } = resolveScript({
    cfg: conf, attempts, item,
    generate: (hint) => extractJson(call(buildScriptPrompt(item, conf, hint), { cfg: conf })),
  });

  // 🔴 검증된 인용 필드를 **결정론적으로** 대본에 붙인다(LLM 이 다시 타이핑한 값이 아니다).
  //    인용 게이트(`gate-quote.mjs:extractQuoteFields`)가 `script.item` 을 읽어 구조 규칙과
  //    원문 대조를 돌린다 — 모델의 재타이핑에 게이트 입력을 걸면, 게이트가 검사하는 것은
  //    우리가 확인한 구절이 아니라 모델이 방금 지어낸 사본이 된다.
  const out = { post_id: postId ?? null, ...script, item: quoteFieldsOf(item) };
  if (postId) {
    const dir = workDir(postId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'script.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
  }
  return { script: out, attempts_used };
}

// ── provenance 영속화 (§5.1 · scripted 전이) ─────────────────────────────────

/**
 * `planned → scripted` 전이 + provenance 기록.
 *
 * 🔴 이 채널에서 "왜 믿었는가"의 답은 **원문 URL + 기계 대조 성공**이다. 그것을 남기지 않으면
 * 테이크다운 런북(R16)이 운영자에게 건네는 것은 발행된 게시물뿐이다. 발행 시점이 아니라
 * **대본 시점**에 남기는 이유: 발행까지 못 간 held 포스트도 같은 질문을 받을 수 있다.
 */
export function persistScripted(postId, { item, script, factcheck = {}, extra = {} } = {}) {
  return transition(postId, 'scripted', {
    backlog_id: item?.id ?? null,
    subject: item?.problem ?? item?.subject ?? null,
    // 🔴 회전축. `freshnessMap` 이 인덱스에서 이 값을 읽는다 — 없으면 백로그 역참조로만
    //    복원되고, 백로그가 정리되는 날 회전이 조용히 멈춘다.
    problem: item?.problem ?? null,
    book: item?.source?.title ?? null,
    author: item?.source?.author ?? null,
    provenance: {
      quote_original: item?.quote_original ?? null,
      fulltext_url: item?.source?.fulltext_url ?? null,
      source_title: item?.source?.title ?? null,
      source_author: item?.source?.author ?? null,
      source_translator: item?.source?.translator ?? null,
      quote_verified: Boolean(factcheck?.machine?.verified),
      factcheck_verdict: factcheck?.verdict ?? null,
      factcheck_source: factcheck?.source ?? null,
      factcheck_note: factcheck?.note ?? null,
      factcheck_corrected: Boolean(item?.factcheck_corrected),
    },
    ...extra,
  });
}

// ── 예비 대본 buffer (§3.6) ──────────────────────────────────────────────────
//
// 목표 5건. `≤2` 로 두면 07-25/26 사고 길이(2일)와 정확히 같아 여유가 0이다.

const bufferFile = (backlogId) => join(bufferDir(), `${String(backlogId).replace(/[^A-Za-z0-9_-]/g, '')}.json`);

/**
 * 적립. **자격: 인용검증 `ok` + TIER-1 게이트 통과분만.**
 * 검증 안 된 대본을 쌓아 두면 장애일에 꺼내 쓰는 순간, 하필 사람이 못 보는 날에
 * 검증되지 않은 것이 나간다 — 버퍼가 안전망이 아니라 우회로가 된다.
 */
export function bankToBuffer({ backlogId, script, provenance = null, tier2Warnings = [], factcheckVerdict, gatePass, now = new Date() } = {}) {
  if (factcheckVerdict !== 'ok') return { banked: false, reason: `factcheck:${factcheckVerdict ?? 'missing'}` };
  if (gatePass !== true) return { banked: false, reason: 'gate:generalization' };
  if (!backlogId || !script) return { banked: false, reason: 'missing-input' };

  mkdirSync(bufferDir(), { recursive: true });
  const row = {
    backlog_id: backlogId, script, provenance,
    tier2_warnings: Array.isArray(tier2Warnings) ? tier2Warnings : [],
    banked_at: now.toISOString(),
  };
  writeFileSync(bufferFile(backlogId), JSON.stringify(row, null, 2) + '\n', 'utf8');
  return { banked: true, reason: 'ok', path: bufferFile(backlogId), row };
}

/** 버퍼 전체 로드(오래된 것 먼저 — FIFO). 깨진 파일은 무시한다. */
export function loadBuffer() {
  const dir = bufferDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => String(a.banked_at).localeCompare(String(b.banked_at)));
}

export function bufferCount() { return loadBuffer().length; }

/** 가장 오래된 1건 소비(파일 제거). 없으면 null. */
export function takeFromBuffer() {
  const all = loadBuffer();
  const first = all[0];
  if (!first) return null;
  try { unlinkSync(bufferFile(first.backlog_id)); } catch { /* 이미 없으면 무시 */ }
  return first;
}

/**
 * refill-to-target — 부족분을 `max_topup_per_run` 까지만 채운다.
 *
 * 🔴 **발행 성공 *후*** 에 호출하고, claude 호출은 `exempt:true` 로 건다. 여기서 예산 초과로
 * throw 하면 **이미 나간 그날이 실패로 기록되고 결방 경보가 오발한다.** 다만 `charge()` 는
 * 정상 수행되므로(면제는 throw 뿐) 공유 원장에 과소보고되지 않는다(F4).
 */
export function topUpBuffer({ cfg = null, produce, now = new Date() } = {}) {
  const conf = cfg || loadConfig();
  const target = conf.buffer?.target ?? 5;
  const maxPerRun = conf.buffer?.max_topup_per_run ?? 2;
  const have = bufferCount();
  const want = Math.min(Math.max(0, target - have), maxPerRun);
  const banked = [];
  const skipped = [];

  for (let i = 0; i < want; i++) {
    let made;
    try { made = produce(); }
    catch (e) {
      // top-up 실패는 절대 런을 죽이지 않는다 — 발행은 이미 끝났다.
      log.warn(`buffer top-up 중단(비차단): ${e.message}`);
      break;
    }
    if (!made) break;
    const r = bankToBuffer({ ...made, now });
    if (r.banked) banked.push(r.row.backlog_id); else skipped.push(r.reason);
  }

  log.info(`buffer: ${have} → ${bufferCount()} (목표 ${target} · 이번 런 최대 ${maxPerRun} · 적립 ${banked.length}${skipped.length ? ` · 자격미달 ${skipped.length}` : ''})`);
  return { before: have, after: bufferCount(), target, max_per_run: maxPerRun, banked, skipped };
}

function main() {
  try {
    const raw = process.argv[2];
    if (!raw) { process.stderr.write('사용법: script.mjs \'<BacklogItem JSON>\' [post_id]\n'); process.exit(2); }
    const item = JSON.parse(raw);
    const r = generateScript(item, { postId: process.argv[3] || null });
    process.stdout.write(JSON.stringify({ ok: true, attempts_used: r.attempts_used, script: r.script }) + '\n');
    process.exit(0);
  } catch (e) {
    log.error(`대본 생성 실패: ${e.message}`);
    process.stdout.write(JSON.stringify({ ok: false, error: e.message, diag: e.diag || null }) + '\n');
    process.exit(2);
  }
}

if (isMainModule(import.meta.url)) main();
