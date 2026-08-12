#!/usr/bin/env node
/**
 * cardnews/gate-quote.mjs — 인용 안전 + 정신건강 경계 게이트 (버티컬: 책 인용 위로)
 *
 * 사용: node scripts/cardnews/gate-quote.mjs <script.json|item.json> [--post-id cn-…]
 *       node scripts/cardnews/gate-quote.mjs --line "검사할 문장"          (코퍼스·디버그)
 * 계약: stdout JSON **정확히 1줄** · exit 0=통과(경고 포함) / 1=차단 / 2=실행오류
 *       (`gates.mjs`·`gate-generalization.mjs` 와 동일 계약.)
 *
 * 🔴 **LLM 호출 0회.** `gate-generalization.mjs` 와 같은 이유다 — 판정을 모델에 맡기면
 * 비싸지고, 비싸지면 샘플링하게 되고, 샘플링하면 이 게이트가 지키려던 것이 확률 게임이 된다.
 * 원문 실재 대조만 네트워크를 쓰는데, 그것도 문자열 포함 검사(결정론)이고 캐시된다.
 *
 * ── 이 게이트가 막는 것 두 가지 ────────────────────────────────────────────────
 *
 * **① 저작권(Q 규칙군).** 이 채널의 유일한 실질 법적 위험이다. 저작권법 28조는 "정당한 범위
 * 안에서 공정한 관행에 합치되게" 인용을 허용하는데, 카드뉴스는 인용문이 주인공이 되기 쉬워
 * 그 선을 넘기 쉽다. 소재를 저작권 만료 고전으로 한정하고 번역도 원문에서 직접 하기로 한
 * 뒤(사용자 결정 2026-07-31)로 위험은 크게 줄었지만, **만료됐다고 전문을 통째로 실을 수는
 * 없으므로** 길이 상한·해설 우위·시 배제는 그대로 강제한다.
 *
 * 여기에 **가짜 인용** 방어가 붙는다. 인터넷에는 그 책에 없는데 그 책 것으로 떠도는 문장이
 * 대량으로 있고 LLM 이 출처까지 그럴듯하게 붙여 뱉는다. 법적 문제 이전에 위로 계정에서
 * 이게 걸리면 계정 정체성이 끝난다. 고전은 원문 전문이 공개돼 있어 **기계적으로 대조
 * 가능**하므로(Q7), 주 판정(`factcheck.mjs`, LLM 경로 섞임)과 별개로 여기서 한 번 더 막는다.
 * 중복이 아니라 의도된 이중화다.
 *
 * **② 정신건강 경계(M 규칙군).** 타깃이 "마음이 지친 사람"이라 실제 임상 상태인 사람이 본다.
 *
 * 🔴 **M 규칙군은 오탐을 감수하고 넓게 잡는다. 이것은 Q 규칙군·일반화 게이트와 정반대
 *    방향의 판단이며, 의도적이다.** 일반화 게이트 TIER-1 이 좁은 이유는 "오탐 1건이 그날
 *    발행을 날린다"였다 — 그 비용은 카드 한 장이다. M 규칙군의 미탐 비용은 **사람 한 명**
 *    이고, 여기에 플랫폼 정책 위반(자해·위기 표현)과 삭제 불가능한 인스타 게시물이 겹친다.
 *    두 비용은 비교 대상이 아니다. 그래서 "위로 문구 하나를 놓치는" 오탐을 기꺼이 받는다.
 *    같은 이유로 M 규칙군은 **패턴 파일로 빼지 않고 코드에 박아 둔다** — 파일로 빼면
 *    파일이 사라졌을 때 `loadLines` 가 빈 배열을 돌려주며 조용히 꺼진다(비하어 G5 가 실제로
 *    그런 구조다). 위기 표현 탐지는 꺼질 수 있으면 안 된다.
 *
 * ── 모드별 검사 범위 ──────────────────────────────────────────────────────────
 * `--line` 은 **텍스트 규칙만** 돌린다(QT1 시 인용 표지 · QT2 무출처 인용 · M1 · M2 · QW1).
 * 구조 규칙(Q0~Q7: 출처 3종·form·public_domain·길이·해설 비율·원문 대조)은 소재 객체가
 * 있어야 판정할 수 있어 파일 모드 전용이다. 코퍼스가 문장 단위인 것도 그래서다.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { makeLogger } from '../lib/log.mjs';
import { REPO_ROOT, loadConfig, stateRoot, sha256, isMainModule } from './lib.mjs';
import { collectParts, appendReviewQueue } from './gate-generalization.mjs';

const log = makeLogger('cardnews/gate-quote');

export const GATE_NAME = 'quote';

// ── 설정 기본값 ──────────────────────────────────────────────────────────────
//
// ⚠ `config/cardnews.json` 에 `quote` 블록이 **없어도 동작해야 한다** — 버티컬 전환이
//   파일별로 진행 중이라 그 블록은 나중에 들어온다. 기본값은 전부 여기서 준다.
export const QUOTE_DEFAULTS = Object.freeze({
  max_chars: 120,
  min_interpretation_ratio: 1.5,
  allowed_forms: Object.freeze(['novel', 'essay', 'nonfiction']),
  require_public_domain: true,
  near_limit_ratio: 0.8,          // 상한의 이 비율을 넘으면 경고(차단 아님)
  verify_source: Object.freeze({
    enabled: true,
    allow_network: true,
    timeout_ms: 15000,
    gutenberg_url: 'https://www.gutenberg.org/cache/epub/{id}/pg{id}.txt',
  }),
});

export function quoteCfg(cfg) {
  const q = cfg?.quote || {};
  const v = q.verify_source || {};
  return {
    ...QUOTE_DEFAULTS,
    ...q,
    allowed_forms: Array.isArray(q.allowed_forms) && q.allowed_forms.length
      ? q.allowed_forms : QUOTE_DEFAULTS.allowed_forms,
    verify_source: { ...QUOTE_DEFAULTS.verify_source, ...v },
  };
}

// ── 어휘 ─────────────────────────────────────────────────────────────────────

/** `form` 값 중 시로 판정하는 것. 스키마에 `poem` 이 없어도 **우회를 막으려고** 게이트가 막는다. */
const POEM_FORMS = new Set(['poem', 'poetry', 'verse', 'lyric', '시', '운문', '시가']);

/**
 * 본문에 드러난 시 인용 표지. `form` 필드를 우회해 카드 본문에만 시를 넣는 경로를 막는다.
 * ⚠ `시` 는 한국어에서 너무 흔한 음절이라(시간·무시·다시) 반드시 **다른 토큰으로 고정**한다:
 *   시인+공백+이름 · 시집/시 + 인용부호 · 시구 + 조사. 맨 `시` 하나는 절대 보지 않는다.
 */
const POEM_TEXT_RULES = [
  { id: 'QT1', label: '시 인용 표지(시인 지목)', re: /시인\s+[가-힣]{2,6}/g },
  { id: 'QT1', label: '시 인용 표지(시인 지목)', re: /[가-힣]{2,6}\s+시인(?:은|는|이|의|도)/g },
  { id: 'QT1', label: '시 인용 표지(시 제목)', re: /(?:의|이라는|라는)\s*시\s*[「『"'“‘]/g },
  { id: 'QT1', label: '시 인용 표지(시집)', re: /시집\s*[「『"'“‘]/g },
  { id: 'QT1', label: '시 인용 표지(시 한 편)', re: /시\s*한\s*편/g },
  { id: 'QT1', label: '시 인용 표지(시구)', re: /시구(?:를|가|는|에|와|의)/g },
  { id: 'QT1', label: '시 인용 표지(운문)', re: /운문/g },
];

/**
 * 인용부호로 감싼 구간. 출처 없이 이만큼을 그대로 옮기면 그게 인용이다.
 * `『』` 는 **책 제목 표기**라 여기서 제외한다 — 그건 인용이 아니라 출처 표시다.
 */
const QUOTED_SPAN = /[“"]([^”"\n]{15,})[”"]|「([^」\n]{10,})」|[‘']([^’'\n]{15,})[’']/g;

/** 출처 표시로 인정하는 표지. 하나라도 있으면 QT2(무출처 인용)를 발화시키지 않는다. */
const ATTRIBUTION = /[『』]|작가|저자|소설가|지음|옮김|의\s*(?:소설|산문|수필|장편|단편|일기|편지)|[—―]\s*\S/;

/** 시 형태 휴리스틱 — 인용 안에 행 구분자가 보이면 산문이 아닐 가능성이 높다(경고). */
const VERSE_SEPARATOR = /\s[/／|｜]\s/;

/**
 * M1 임상 조언·진단·처방 뉘앙스.
 *
 * "낫는다·나아진다" 같은 **회복 서술 일반**은 넣지 않았다 — "마음이 조금씩 나아진다"는 이
 * 채널이 매일 쓰는 문장이고, 그걸 막으면 넓은 게이트가 아니라 쓸모없는 게이트가 된다.
 * 넓게 잡는다는 것은 **임상 프레임**(치료·진단·처방·복약·상담 불필요·임상 명칭 라벨링)을
 * 넓게 잡는다는 뜻이지, 위로 어휘까지 쓸어 담는다는 뜻이 아니다.
 */
const CLINICAL_RULES = [
  { id: 'M1', label: '임상 조언(완치·치료 단정)', re: /완치|치료(?:가|는|를)?\s*(?:된|돼|됩니|필요\s*없|안\s*받아도)/g },
  { id: 'M1', label: '임상 조언(질환 극복 단정)', re: /(?:우울증|불안장애|공황장애|공황|조울증|트라우마|정신과)[^.!?\n]{0,25}(?:낫|나아|치료|완치|사라지|극복|필요\s*없)/g },
  { id: 'M1', label: '임상 조언(진단)', re: /진단/g },
  { id: 'M1', label: '임상 조언(처방)', re: /처방/g },
  { id: 'M1', label: '임상 조언(복약 중단)', re: /약(?:을|은)?\s*(?:끊|중단|안\s*먹|줄이|줄여)/g },
  { id: 'M1', label: '임상 조언(치료 회피 권유)', re: /(?:병원|상담)(?:에|을|은|를)?\s*(?:안\s*가|갈\s*필요\s*없|받을\s*필요\s*없|필요\s*없)/g },
  { id: 'M1', label: '임상 조언(글이 치료를 대체)', re: /(?:글귀|문장|책|카드|이\s*글)[^.!?\n]{0,20}(?:치료|약|상담)(?:을|를)?\s*(?:대신|대체)/g },
  { id: 'M1', label: '임상 라벨링(유사 진단명)', re: /나르시시스트|소시오패스|사이코패스|경계성\s*인격|인격장애/g },
];

/**
 * M2 자해·위기 표현. **감지 즉시 차단**(경고 아님).
 *
 * 여기서는 오탐을 세지 않는다. "죽어버린 감정" 같은 비유가 걸리는 건 알고 있고, 그래도 둔다.
 * 이 규칙군에서 놓치는 비용과 넘치는 비용은 같은 저울에 올라가지 않는다.
 */
const CRISIS_RULES = [
  { id: 'M2', label: '위기 표현(자살·자해)', re: /자살|자해|극단적\s*선택|목숨을\s*끊|스스로\s*목숨/g },
  { id: 'M2', label: '위기 표현(죽음 소망)', re: /죽고\s*싶|죽어\s*버리|죽어버리|죽는\s*게\s*낫|살고\s*싶지\s*않|살\s*이유가\s*없/g },
  { id: 'M2', label: '위기 표현(소멸 소망)', re: /사라지고\s*싶|없어지고\s*싶|증발하고\s*싶/g },
  // 활용형을 손으로 넓힌다(긋다 → 그은·그었·그어). 어간만 잡으면 "손목을 그은"을 놓치는데,
  // 이 규칙군에서 놓치는 것의 비용은 카드 한 장이 아니다.
  { id: 'M2', label: '위기 표현(수단 언급)', re: /(?:손목|팔목|허벅지)(?:을|를|에)?\s*(?:긋|그어|그은|그었)|번개탄|투신|유서(?:를)?\s*(?:쓰|남기)|약(?:을)?\s*(?:모아|털어)/g },
];

// ── 글자 수 ──────────────────────────────────────────────────────────────────

/**
 * 공백을 뺀 코드포인트 수. 인용 상한과 해설 비율이 **같은 자로 재야** 비교가 성립하므로
 * 세는 방법을 한 곳에 둔다. 공백을 빼는 이유: 줄바꿈·들여쓰기가 분량으로 계산되면
 * 원문을 그대로 옮겨 놓고도 상한을 넘지 않는 구멍이 생긴다.
 */
export function countChars(s) {
  return [...String(s ?? '').replace(/\s+/g, '')].length;
}

// ── 원문 정규화 (실재 대조) ──────────────────────────────────────────────────

/**
 * 강한 정규화 — 구두점·기호를 전부 지우고 공백 1칸으로 접는다.
 *
 * 🔴 **단순 `includes` 는 false negative 를 낸다.** 구텐베르크 원문은 70자 안팎에서
 * 줄바꿈으로 감겨 있어, 실재하는 구절도 문자열이 그대로 들어 있지 않다. 구두점까지
 * 지우는 이 정규화가 대조의 전제다.
 *
 * ⚠ 문자 클래스는 `[a-z0-9가-힣]` 이 아니라 **유니코드 속성**(`\p{L}\p{N}`)을 쓴다.
 *   ASCII+한글만 남기면 나쓰메 소세키(가나·한자)·톨스토이(키릴)·프랑스어(악센트) 원문이
 *   통째로 지워져 "정규화 결과 빈 문자열"이 아무 문자열에나 포함되는 참사가 난다.
 *   영어 원문에 대해서는 두 방식의 결과가 동일하다.
 */
export function strongNormalize(s) {
  return String(s ?? '').normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 공백까지 전부 지운 형태. 일본어·중국어처럼 **띄어쓰기가 없는 원문**은 줄바꿈이 곧
 * 공백으로 바뀌어 `strongNormalize` 만으로는 여전히 어긋난다(「吾輩は猫である。名前は\nまだ
 * 無い」 → "… 名前は まだ無い" vs 인용문 "…名前はまだ無い"). 공백을 지운 쪽도 함께 본다.
 * 영어에서는 단어가 붙을 뿐 양쪽에 같은 변형이 적용되므로 판별력이 떨어지지 않는다.
 */
export function tightNormalize(s) {
  return strongNormalize(s).replace(/ /g, '');
}

/** 원문 전문에 인용 원문이 실재하는가. 두 정규화 중 하나라도 포함되면 실재로 본다. */
export function quoteExistsIn(fullText, quoteOriginal) {
  const q = strongNormalize(quoteOriginal);
  if (!q) return false;
  if (strongNormalize(fullText).includes(q)) return true;
  const qt = tightNormalize(quoteOriginal);
  return Boolean(qt) && tightNormalize(fullText).includes(qt);
}

// ── 원문 전문 확보 (캐시 우선) ───────────────────────────────────────────────

/** 원문 전문 캐시 디렉터리. ⚠ `.gitignore` 에 등록돼 있어야 한다(수백 KB×작품 수). */
export function fulltextDir() {
  return process.env.CARDNEWS_FULLTEXT_DIR || join(stateRoot(), 'fulltext');
}

/** 캐시 키 — 구텐베르크 id 가 있으면 그것, 없으면 URL 해시. */
export function fulltextCachePath(source = {}) {
  const id = source.gutenberg_id ?? source.gutenberg ?? null;
  const name = id != null
    ? `gutenberg-${String(id).replace(/[^\w.-]/g, '')}.txt`
    : `${sha256(String(source.fulltext_url || '')).slice(0, 16)}.txt`;
  return join(fulltextDir(), name);
}

/** 소재의 원문 URL. 명시 URL 우선, 없으면 구텐베르크 id 로 조립. */
export function fulltextUrl(source = {}, q = QUOTE_DEFAULTS) {
  if (source.fulltext_url) return String(source.fulltext_url);
  const id = source.gutenberg_id ?? source.gutenberg ?? null;
  if (id == null) return null;
  return String(q.verify_source.gutenberg_url).replace(/\{id\}/g, String(id));
}

/**
 * 원문 전문을 얻는다: ① 로컬 파일(`source.fulltext_file` — 한국 고전처럼 구텐베르크에 없는
 * 작품·테스트 픽스처) ② 캐시 ③ 네트워크(받으면 캐시에 저장).
 *
 * `CARDNEWS_NO_NETWORK=1` 이면 ③ 을 건너뛴다 — 테스트는 **네트워크 없이** 돌아야 한다.
 * @returns {Promise<{text:string|null, source:string|null, detail:string}>}
 */
export async function resolveFullText(source = {}, q = QUOTE_DEFAULTS) {
  if (source.fulltext_file) {
    const p = resolve(REPO_ROOT, String(source.fulltext_file));
    if (existsSync(p)) return { text: readFileSync(p, 'utf8'), source: 'file', detail: p };
    return { text: null, source: null, detail: `원문 파일 없음: ${p}` };
  }

  const cache = fulltextCachePath(source);
  if (existsSync(cache)) return { text: readFileSync(cache, 'utf8'), source: 'cache', detail: cache };

  const url = fulltextUrl(source, q);
  if (!url) return { text: null, source: null, detail: '원문 위치 없음(fulltext_file·fulltext_url·gutenberg_id 전무)' };
  if (process.env.CARDNEWS_NO_NETWORK === '1' || q.verify_source.allow_network === false) {
    return { text: null, source: null, detail: `캐시 없음 + 네트워크 비활성: ${url}` };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), q.verify_source.timeout_ms);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'follow' });
    if (!res.ok) return { text: null, source: null, detail: `HTTP ${res.status} ${url}` };
    const text = await res.text();
    try {
      mkdirSync(fulltextDir(), { recursive: true });
      writeFileSync(cache, text, 'utf8');
    } catch (e) {
      log.warn(`원문 캐시 저장 실패(비차단): ${e.message}`);
    }
    return { text, source: 'network', detail: url };
  } catch (e) {
    return { text: null, source: null, detail: `수신 실패: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Q7 원문 실재 대조.
 *
 * 상태: `found`(실재) · `not_found`(원문에 없음 = 가짜 인용) · `unavailable`(원문을 못 구함) ·
 * `disabled`(설정으로 끔) · `skipped`(대조 대상 없음).
 *
 * 🔴 `unavailable` 은 **차단하되 `not_found` 와 구분해서 기록**한다. 둘 다 그날은 못 나가지만
 * (확인 불가면 거른다), 전자는 다음 런에 다시 시도할 일시 실패고 후자는 소재 자체를
 * 버려야 하는 영구 실패다. 이 구분을 뭉개면 네트워크가 한 번 흔들렸다고 멀쩡한 소재가
 * 영구 폐기되거나, 반대로 가짜 인용이 재시도 큐에서 계속 되살아난다.
 */
export async function verifyQuoteOriginal(fields, cfg) {
  const q = quoteCfg(cfg);
  if (!q.verify_source.enabled) return { status: 'disabled', matched: null, source: null, detail: '설정으로 비활성' };
  if (!fields.quoteOriginal) {
    return { status: 'unavailable', matched: null, source: null, detail: 'quote_original 없음 — 우리 번역(quote_ko)은 원문과 대조할 수 없다' };
  }
  const { text, source, detail } = await resolveFullText(fields.source || {}, q);
  if (!text) return { status: 'unavailable', matched: null, source: null, detail };
  const matched = quoteExistsIn(text, fields.quoteOriginal);
  return { status: matched ? 'found' : 'not_found', matched, source, detail };
}

// ── 소재 필드 추출 ───────────────────────────────────────────────────────────

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * 대본·소재 어느 쪽을 줘도 인용 필드를 찾아낸다.
 *
 * 스키마가 이행 중이라(다른 에이전트가 `backlog.mjs`·`script.mjs` 를 동시에 고치는 중)
 * 인용 필드가 최상위에 있을 수도, `item`/`source_item` 아래에 있을 수도 있다. 여기서
 * 추측을 흡수해 두면 스키마가 정착할 때 이 게이트를 다시 손대지 않아도 된다.
 */
export function extractQuoteFields(obj = {}) {
  const cand = [obj, obj.item, obj.source_item, obj.backlog_item, obj.subject].filter(
    (o) => o && typeof o === 'object');
  const pick = (key) => {
    for (const o of cand) if (o[key] != null) return o[key];
    return undefined;
  };
  // `source` 는 키 존재 여부(translator 누락 vs 명시적 null)를 봐야 해서 객체째로 집는다.
  let source = undefined;
  for (const o of cand) if (o.source && typeof o.source === 'object') { source = o.source; break; }

  const quoteKo = pick('quote_ko') ?? pick('quote');
  const quoteOriginal = pick('quote_original');
  const interpretation = pick('interpretation');
  const form = pick('form');
  let publicDomain = undefined;
  for (const o of cand) if (hasOwn(o, 'public_domain')) { publicDomain = o.public_domain; break; }

  return {
    quoteKo, quoteOriginal, interpretation, form, source, publicDomain,
    present: [quoteKo, quoteOriginal, source, form].some((v) => v !== undefined),
  };
}

// ── 구조 규칙 (파일 모드 전용) ───────────────────────────────────────────────

/**
 * Q0~Q6. Q7(원문 대조)은 비동기라 따로 돈다.
 * @returns {{hits:Array, warns:Array}}
 */
export function checkStructure(fields, cfg) {
  const q = quoteCfg(cfg);
  const hits = [];
  const warns = [];
  const hit = (rule, label, match) => hits.push({ rule, label, field: 'item', match: String(match).slice(0, 80) });

  // Q0 — 인용 필드를 아예 못 찾았다. **fail-closed.**
  //
  // 이 채널의 모든 게시물은 인용을 담는다. 인용 필드가 없다는 것은 (a) 스키마가 어긋났거나
  // (b) 인용이 본문에 출처 없이 숨어 들어갔다는 뜻이고, 둘 다 통과시킬 이유가 없다.
  // "모르면 통과"는 안전 게이트가 가장 흔하게 죽는 방식이다.
  if (!fields.present) {
    hit('Q0', '인용 필드 없음(스키마 불일치 또는 인용 누락)', '(quote_ko·quote_original·source·form 전무)');
    return { hits, warns };
  }

  // Q1 — 시는 존재 자체가 위반. 스키마에 `poem` 이 없어도 게이트가 막는다(우회 차단).
  const form = typeof fields.form === 'string' ? fields.form.trim().toLowerCase() : null;
  if (form && POEM_FORMS.has(form)) {
    hit('Q1', '시 형태(form=poem) — 짧은 시는 두세 줄만 인용해도 작품의 상당 부분이 된다', fields.form);
  } else if (!form || !q.allowed_forms.includes(form)) {
    hit('Q2', `form 누락·미허용(허용: ${q.allowed_forms.join('|')})`, fields.form ?? '(없음)');
  }

  // Q3 — 출처 3종. title·author 는 값이 있어야 하고, translator 는 **키가 있어야** 한다.
  //
  // `translator: null` 은 정상 통과 경로다 — 소재가 저작권 만료 고전으로 한정되고 번역을
  // 우리가 원문에서 직접 하기 때문에(사용자 결정 2026-07-31) 역자가 없는 것이 기본값이다.
  // 그런데 **키 누락과 명시적 null 을 뭉개면 안 된다**: 전자는 "역자 정보를 빠뜨렸다"이고
  // 후자는 "역자가 없다고 확인했다"이다. 기존 번역서를 인용하면서 역자를 안 적은 건 번역자
  // 저작권을 그대로 밟는 경로라, 이 구분이 곧 안전 장치다.
  const src = fields.source;
  if (!src || typeof src !== 'object') {
    hit('Q3', '출처 객체 없음(title·author·translator 필수)', String(src));
  } else {
    for (const k of ['title', 'author']) {
      const v = src[k];
      if (typeof v !== 'string' || !v.trim()) hit('Q3', `출처 ${k} 누락·공백`, v ?? '(없음)');
    }
    if (!hasOwn(src, 'translator') || src.translator === undefined) {
      hit('Q3', 'translator 키 누락 — 원서(null)와 누락은 다르다. 자체 번역이면 null 을 명시하라', '(키 없음)');
    } else if (src.translator !== null && (typeof src.translator !== 'string' || !src.translator.trim())) {
      hit('Q3', 'translator 값이 빈 문자열 — null(자체 번역·원서) 로 명시하라', String(src.translator));
    }
  }

  // Q4 — 저작권 만료 확인. 판정은 소재 단계에서 하지만 게이트가 마지막으로 한 번 더 막는다.
  if (q.require_public_domain && fields.publicDomain !== true) {
    hit('Q4', 'public_domain !== true — 만료 확인이 안 된 작품은 인용하지 않는다',
      fields.publicDomain === undefined ? '(키 없음)' : String(fields.publicDomain));
  }

  // Q5/Q6 — 분량. 카드에 실리는 것은 우리 번역(quote_ko)이므로 그것으로 잰다.
  const qLen = countChars(fields.quoteKo);
  const iLen = countChars(fields.interpretation);
  if (!qLen) {
    hit('Q5', '인용문(quote_ko) 없음', '(없음)');
  } else if (qLen > q.max_chars) {
    hit('Q5', `인용 길이 초과 ${qLen}자 > 상한 ${q.max_chars}자 — 한두 문장을 넘으면 "정당한 범위"를 다툰다`, fields.quoteKo);
  } else if (qLen > q.max_chars * q.near_limit_ratio) {
    warns.push({ rule: 'QW2', label: `인용 길이 상한 근접 ${qLen}/${q.max_chars}자`, field: 'item', match: String(fields.quoteKo).slice(0, 80) });
  }

  if (qLen) {
    if (!iLen) {
      hit('Q6', '해설(interpretation) 없음 — 인용이 종속적이어야 28조가 성립한다', '(없음)');
    } else if (iLen < qLen * q.min_interpretation_ratio) {
      hit('Q6', `해설이 짧다 ${iLen}자 < 인용 ${qLen}자 × ${q.min_interpretation_ratio} — 인용이 주인공이 되면 인용이 아니다`,
        `해설 ${iLen} / 인용 ${qLen}`);
    }
  }

  // QW1(구조판) — 시 형태 휴리스틱. **인용문 필드에만** 적용한다.
  // 카드 본문은 설계상 짧은 줄의 연속이라 본문 전체에 걸면 매 건 경고가 뜬다(= 경고가
  // 정보가 아니게 된다). 차단이 아니라 경고인 이유도 같다 — 휴리스틱은 틀릴 수 있다.
  const verseLike = poemShaped(fields.quoteOriginal) || poemShaped(fields.quoteKo);
  if (verseLike) {
    warns.push({ rule: 'QW1', label: '시 형태 의심(짧은 행의 연속) — 산문인지 확인 필요', field: 'item', match: verseLike });
  }

  return { hits, warns };
}

/** 짧은 행이 2행 이상 연속되면 시 형태로 의심한다. @returns {string|null} 증거 문자열 */
export function poemShaped(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  if (lines.every((l) => [...l].length <= 25)) return lines.join(' / ').slice(0, 80);
  return null;
}

// ── 텍스트 규칙 (양 모드 공통) ───────────────────────────────────────────────

const snippet = (m) => String(m).replace(/\s+/g, ' ').slice(0, 80);

function scanRules(text, rules, out, field) {
  for (const r of rules) {
    r.re.lastIndex = 0;
    let m;
    while ((m = r.re.exec(text)) !== null) {
      out.push({ rule: r.id, label: r.label, field, match: snippet(m[0]) });
      if (m.index === r.re.lastIndex) r.re.lastIndex++;   // 영길이 매칭 무한루프 방지
    }
  }
}

/** 한 조각의 텍스트 규칙 전체. @returns {{hits:Array, warns:Array}} */
export function checkText(text, field = 'line') {
  const hits = [];
  const warns = [];
  const t = String(text ?? '');
  if (!t.trim()) return { hits, warns };

  scanRules(t, POEM_TEXT_RULES, hits, field);
  scanRules(t, CLINICAL_RULES, hits, field);
  scanRules(t, CRISIS_RULES, hits, field);

  // QT2 무출처 인용 — 인용부호로 옮겨 놓고 출처를 안 붙인 경우.
  QUOTED_SPAN.lastIndex = 0;
  let m;
  while ((m = QUOTED_SPAN.exec(t)) !== null) {
    const span = m[1] ?? m[2] ?? m[3] ?? '';
    if (!ATTRIBUTION.test(t)) {
      hits.push({ rule: 'QT2', label: '무출처 인용 — 출처 없는 인용은 이 채널의 정체성 자체를 부정한다', field, match: snippet(span) });
    }
    if (VERSE_SEPARATOR.test(span)) {
      warns.push({ rule: 'QW1', label: '시 형태 의심(인용 안에 행 구분자) — 산문인지 확인 필요', field, match: snippet(span) });
    }
    if (m.index === QUOTED_SPAN.lastIndex) QUOTED_SPAN.lastIndex++;
  }

  return { hits, warns };
}

// ── 조립 ─────────────────────────────────────────────────────────────────────

function verdict(tier1_hits, tier2_warnings, verification) {
  const pass = tier1_hits.length === 0;
  let reason;
  if (!pass) {
    reason = `차단 ${tier1_hits.length}건: ${tier1_hits.map((h) => `${h.rule}@${h.field}`).join(', ')}`;
  } else {
    reason = tier2_warnings.length ? `경고 ${tier2_warnings.length}건(비차단)` : '이상 없음';
  }
  return { pass, reason, evidence: { tier1_hits, tier2_warnings, verification } };
}

/**
 * 대본·소재 1건 판정. **비동기**다 — Q7 원문 대조가 네트워크(또는 캐시 I/O)를 탄다.
 * `gate-generalization.runGate` 가 동기인 것과 다르니 호출부에서 `await` 를 빠뜨리지 말 것.
 */
export async function runGate(obj, { cfg = null, postId = null, appendQueue = true } = {}) {
  const conf = cfg || loadConfig();
  const fields = extractQuoteFields(obj);
  const { hits, warns } = checkStructure(fields, conf);

  // 텍스트 규칙은 대본 전 필드에 돌린다 — 캡션에만 숨은 위기 표현이 통과하면 게이트가
  // 없는 것과 같다. 조각 수집은 일반화 게이트와 **같은 함수**를 쓴다(검사 범위가 갈라지면
  // 한쪽만 보는 필드가 생긴다).
  const parts = collectParts(obj);
  for (const { field, text } of parts) {
    const r = checkText(text, field);
    hits.push(...r.hits);
    warns.push(...r.warns);
  }
  // 인용문·해설 자체도 텍스트 규칙 대상(대본 조각에 안 실릴 수 있다).
  for (const [field, text] of [['item.quote_ko', fields.quoteKo], ['item.interpretation', fields.interpretation]]) {
    if (typeof text === 'string' && text.trim()) {
      const r = checkText(text, field);
      hits.push(...r.hits);
      warns.push(...r.warns);
    }
  }

  let verification = { status: 'skipped', matched: null, source: null, detail: '인용 필드 없음' };
  if (fields.present) {
    verification = await verifyQuoteOriginal(fields, conf);
    if (verification.status === 'not_found') {
      hits.push({ rule: 'Q7', label: '원문에 없는 구절(가짜 인용) — 원문 전문 대조 실패', field: 'item', match: snippet(fields.quoteOriginal) });
    } else if (verification.status === 'unavailable') {
      hits.push({
        rule: 'Q7', field: 'item', transient: true,
        label: `원문 대조 불가 — 확인 불가면 그날 거른다(${verification.detail})`,
        match: snippet(fields.quoteOriginal ?? '(quote_original 없음)'),
      });
    } else if (verification.status === 'disabled') {
      warns.push({ rule: 'QW3', label: '원문 실재 대조가 꺼져 있다(quote.verify_source.enabled=false)', field: 'item', match: '-' });
    }
  }

  const pid = postId || obj?.post_id || null;
  if (appendQueue && warns.length) appendReviewQueue(pid, warns, { gate: GATE_NAME });
  return { gate: GATE_NAME, post_id: pid, ...verdict(hits, warns, verification) };
}

/**
 * 문장 1줄 판정(코퍼스·디버그용 — 리뷰큐를 건드리지 않는다).
 * 구조 규칙은 돌지 않는다(판정할 객체가 없다). 동기다.
 */
export function runGateOnLine(line) {
  const { hits, warns } = checkText(String(line), 'line');
  return {
    gate: GATE_NAME, post_id: null,
    ...verdict(hits, warns, { status: 'skipped', matched: null, source: null, detail: '--line 모드(구조 규칙 미적용)' }),
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const lineIdx = argv.indexOf('--line');
  const postIdx = argv.indexOf('--post-id');
  const postId = postIdx >= 0 ? argv[postIdx + 1] : null;

  let result;
  try {
    if (lineIdx >= 0) {
      const line = argv[lineIdx + 1];
      if (line == null) { process.stderr.write('사용법: gate-quote.mjs --line "<문장>"\n'); process.exit(2); }
      result = runGateOnLine(line);
    } else {
      // 위치 인자 = `--` 플래그도, 플래그의 값도 아닌 첫 토큰(gate-generalization.mjs 와 동일).
      let file = null;
      for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith('--')) { i++; continue; }
        file = argv[i]; break;
      }
      if (!file) { process.stderr.write('사용법: gate-quote.mjs <script.json|item.json> [--post-id cn-…] | --line "<문장>"\n'); process.exit(2); }
      const obj = JSON.parse(readFileSync(resolve(file), 'utf8'));
      result = await runGate(obj, { postId });
    }
  } catch (e) {
    // exit 2 = 실행오류. 판정 실패를 "통과"로도 "차단"으로도 보고하지 않는다.
    process.stdout.write(JSON.stringify({ gate: GATE_NAME, pass: false, error: e.message }) + '\n');
    process.stderr.write(`게이트 실행 오류: ${e.message}\n`);
    process.exit(2);
  }

  process.stdout.write(JSON.stringify(result) + '\n');   // stdout 은 JSON 정확히 1줄
  for (const h of result.evidence.tier1_hits) log.warn(`차단 ${h.rule} @${h.field}: ${h.match}`);
  for (const w of result.evidence.tier2_warnings) log.warn(`경고 ${w.rule} @${w.field}: ${w.match}`);
  process.exit(result.pass ? 0 : 1);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stdout.write(JSON.stringify({ gate: GATE_NAME, pass: false, error: e.message }) + '\n');
    process.stderr.write(`게이트 실행 오류: ${e.message}\n`);
    process.exit(2);
  });
}
