#!/usr/bin/env node
/**
 * cardnews/gate-generalization.mjs — 일반화·비하 2단 게이트 (계획 §3.7, AC-21·R16)
 *
 * 사용: node scripts/cardnews/gate-generalization.mjs <script.json> [--post-id cn-…]
 *       node scripts/cardnews/gate-generalization.mjs --line "검사할 문장"      (코퍼스·디버그)
 *       node scripts/cardnews/gate-generalization.mjs --expire                 (§review 자동만료)
 *       node scripts/cardnews/gate-generalization.mjs --digest [YYYY-MM]       (§review 월간요약)
 * 계약(판정 모드 — 파일·--line): stdout JSON **정확히 1줄** · exit 0=통과(경고 포함) / 1=차단 /
 *       2=실행오류(`scripts/gates/check-banned.mjs` 와 동일 계약)
 * 계약(큐 수명주기 모드 — --expire·--digest): stdout JSON **정확히 1줄** · exit 0=완료 /
 *       2=실행오류. pass/fail 개념이 없어 exit 1 은 쓰지 않는다.
 *
 * 🔴 **LLM 호출 0회.** 순수 정규식이라 카드 한 장당 비용이 0이고, 그래서 "매 건 전수 검사"가
 * 가능하다. 판정을 모델에 맡기면 비싸지고, 비싸지면 샘플링하게 되고, 샘플링하면 이 게이트가
 * 지키려던 것(공개 브랜드 계정에 고정관념이 한 건도 나가지 않는 것)이 확률 게임이 된다.
 *
 * ── 축 교체 — 국명 → 성별·연령·유형 (2026-07-31 버티컬 전환) ────────────────────
 * 이 게이트는 세계 문화 채널용으로 만들어졌고 G1·G2·G6 이 **국명**을 축으로 삼았다.
 * 버티컬이 "책 인용 위로"(연애·인간관계)로 바뀌면서 국명이 본문에 아예 등장하지 않게 됐고,
 * 축을 그대로 두면 TIER-1 이 **한 건도 발화하지 않는다**. 실측(2026-07-31):
 *   "여자들은 다 그렇다" → PASS · "남자는 원래 무심하다" → PASS
 * ⚠ 이때 코드는 아무 경고도 찍지 않는다 — `국명 목록이 비어…` 경고는 목록 파일이 **비어
 *   있을 때만** 나오고, 여기서는 목록이 멀쩡히 차 있는데 본문에 그 축이 없을 뿐이기
 *   때문이다. 즉 "조용히 무력화된 게이트"였고, 그래서 축을 파일 단위로 갈아끼운다.
 *
 * 막아야 할 문형은 **구조가 같고 축만 다르다**. 규칙 구조(G1 전칭 / G2 본질화 / G3 우열 /
 * G4 본성 단정 / G6 사람 주어)를 그대로 두고 `config/cardnews-groups.txt` 로 축만 바꿨다.
 *   기존: "일본 사람들은 다 ~"   신규: "여자들은 다 ~" · "INFP는 항상 ~" · "20대는 ~"
 * 구 국명 축·구 코퍼스는 `*.worldculture.bak` 로 보존한다(되돌릴 수 있어야 한다).
 *
 * 축 토큰에 붙는 사람-주어 표지도 함께 바뀐다: 국명은 `사람들/인들` 이 **필수**였지만
 * (일본 → "일본 사람들은"), 성별·유형 축은 토큰 자체가 사람을 가리켜 표지가 **선택적**이다
 * ("여자들은"·"남자는"). 그래서 `GROUP_MARK` 가 `?` 다.
 *
 * ── 왜 2단인가 ───────────────────────────────────────────────────────────────
 * TIER-1 은 **좁게 차단**한다(exit 1). 축 토큰이 명시된 문장만 본다. 좁은 이유는 오탐 1건이
 * 그날의 발행을 통째로 날리기 때문이고, 이 채널의 정상 문장("오늘 마음이 무거웠다면 그건
 * 당신이 약해서가 아니다")이 사람 집단을 주어로 삼지 않기 때문이다.
 *
 * 그런데 축 토큰을 요구하는 순간, **"그런 사람들은 원래 다 그렇다"는 구조적으로 통과한다.**
 * 축이 없다는 이유만으로. 고정관념은 축을 지운다고 사라지지 않으므로 이건 미탐이 아니라
 * 설계 결함이다. 그래서 TIER-2 가 **넓게 경고**한다(exit 0 + `review-queue.jsonl`): 국민호칭
 * 단독(외국인·현지인·○○인), 지시대명사+복수("그런 사람들"), 그리고 창(window) 길이와 무관한
 * 장거리 본질화(한 문장 안에 `사람들/남자/여자` 와 `천성/유전자/본능`이 함께 있는 경우).
 *
 * TIER-2 가 차단하지 않는 이유: 넓은 규칙은 오탐이 섞이고, 오탐이 차단이면 사람이 게이트를
 * 끄게 된다. 대신 사람이 읽는 큐로 흘려보내고, §3.19 가 그 큐의 적체를 감시한다.
 *
 * ── 큐 수명주기 — 자동만료 + 월간요약 (사용자 결정 2026-07-31) ────────────────────
 * 원래 설계(§3.19 `checkCardnewsAutoPause`, Step 6 소관·미구현)는 `stale_review_days` 초과
 * 미검토 TIER-2 가 있으면 채널을 자동 정지시키는 것이었다. 그런데 이 채널은 애초에 "사람 검수
 * 없음"이 전제라, 정지를 막을 사람이 없다 — 첫 경고로부터 14일 뒤 정지가 **예정된 동작**이었다
 * (독립 검토 지적). 사용자는 `config/cardnews.json review.auto_pause_on_stale=false` 로 정지를
 * 끄고, 대신 (1) `expireStaleReviews` 가 `auto_expire_days` 지난 미검토 항목을 자동으로
 * 검토완료 처리해 큐가 무한정 쌓이지 않게 하고, (2) `monthlyDigest` 가 한 달에 한 번 무엇이
 * 사람 눈 없이 나갔는지 요약해 보여준다. **이것은 리스크 수용이다** — 애매한 표현이 실시간
 * 검수 없이 발행될 수 있고, 인스타그램은 삭제 API 가 없다.
 */
import {
  readFileSync, existsSync, mkdirSync, appendFileSync, writeFileSync, renameSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { makeLogger } from '../lib/log.mjs';
import { REPO_ROOT, loadConfig, reviewQueuePath, stateRoot, isMainModule, kstDate } from './lib.mjs';

const log = makeLogger('cardnews/gate-generalization');

export const GATE_NAME = 'generalization';

// ── 어휘 ─────────────────────────────────────────────────────────────────────

/** 전칭 부사·한정어 — "예외 없이 전부"를 뜻하는 말. G1·W1·W2 공용. */
const ALL_ADV = '다|모두|전부|항상|늘|언제나|역시|원래|하나같이|죄다|다들|무조건|예외\\s*없이';

/**
 * 축 토큰 뒤의 사람-주어 표지. 국명 축에서는 `사람들|인들` 이 **필수**였지만(일본 →
 * "일본 사람들은"), 성별·유형 축은 토큰 자체가 사람을 가리켜 **선택적**이다("여자들은" ·
 * "남자는" · "여자애들은"). `?` 하나가 이 축 교체의 핵심 차이다.
 */
const GROUP_MARK = '(?:들|사람들?|인들?|애들)?(?:은|는)';

/**
 * 개별 지칭 배제 — "그 남자는 결국 떠났다"는 일반화가 아니라 **한 사람 이야기**다.
 *
 * 국명 축에는 이 문제가 없었다("일본 사람들은"이 개인을 가리키는 일은 없다). 사람 축으로
 * 옮기는 순간 생긴 새 오탐원이고, 하필 이 버티컬(연애·인간관계)에서 가장 자주 쓰이는
 * 문형이다. 지시관형사·수관형사가 앞에 붙으면 TIER-1 에서 빼고, 대신 TIER-2(W2)가
 * 복수형일 때만 경고로 받는다.
 */
const NOT_INDIVIDUAL = '(?<!(?:그|이|저|한|어떤)\\s)';

/**
 * 본질화 어휘 — 차이의 원인을 사람의 본질로 돌리는 말.
 *
 * G2 와 W3 가 **다른 목록**을 쓴다. G2 는 앞에 `축 토큰 + 은/는` 이라는 강한 조건이 이미
 * 붙어 있어 넓은 어휘(`피가`)를 넣어도 안전하다. W3 는 문장 안 공존만 보므로 같은 어휘가
 * 곧바로 오탐이 된다 — `피가` 는 "손에 피가 묻는다"에 걸린다.
 * (`민족|혈통` 은 국명 축 시절의 잔여 어휘다. 이 버티컬에서는 사실상 발화하지 않지만
 *  본질화 어휘라는 성격은 축과 무관하므로 지우지 않는다 — 축을 되돌릴 때 필요하다.)
 */
const ESSENCE_G2 = '민족|천성|본성|본능|피가|혈통|유전자|DNA|타고나|태생적|생래적|원래\\s*그런';
const ESSENCE_W3 = '민족성|민족적|천성|본성|본능|혈통|유전자|DNA|타고나|태생적|생래적|원래\\s*그런';

/** 우열 어휘 — 집단 사이 서열. G3. */
const SUPERIORITY = '우수|우월|열등|미개|후진|뒤떨어|뒤쳐|앞서|낫다|낫습니|못하다|못합니|수준\\s*낮|수준\\s*높|저급|고급스럽';

/** 국민호칭 접미 — "○○인/○○인들". W1. */
const DEMONYM_RE = /([가-힣]{2,6}인)(?:들)?(?:은|는)\s*(?:다|모두|전부|항상|늘|언제나|역시|원래|하나같이|죄다|다들|무조건)/g;

/**
 * `…인` 으로 끝나지만 국민호칭이 **아닌** 말. W1 은 국명을 요구하지 않으므로(그게 존재
 * 이유다) 접미사만으로 판정할 수밖에 없고, 그러면 "직장인은 다 바쁘다" 같은 무관한 문장이
 * 걸린다. 경고 큐가 무관한 문장으로 차면 사람이 큐를 안 읽게 되므로, 여기서 걷어낸다.
 * ⚠ `외국인`·`현지인` 은 **일부러 넣지 않았다** — 그 일반화야말로 이 채널이 감시할 대상이다.
 */
const NON_DEMONYM = new Set([
  '직장인', '사회인', '성인', '미성년인', '노인', '장인', '연예인', '개인', '본인', '타인',
  '지인', '군인', '상인', '시인', '주인', '현대인', '고인', '증인', '범인', '환자인',
  '학생인', '부인', '남인', '여인', '가족인', '친구인', '동인', '법인', '보인', '관인',
]);

// ── 패턴 파일 로딩 (check-banned.mjs:23-45 관례) ─────────────────────────────

/**
 * 사람 축 파일 경로.
 *
 * ⚠ `channel.countries_file`(구 국명 축)은 **폴백으로 쓰지 않는다.** 그 키는 아직
 * `config/cardnews.json` 에 남아 있을 수 있는데(버티컬 전환 작업이 파일별로 진행 중),
 * 가리키는 파일은 `.worldculture.bak` 로 옮겨져 존재하지 않는다. 폴백으로 물리면
 * `loadLines` 가 빈 배열을 돌려주고 TIER-1 이 **조용히 꺼진다** — 이 레포에서 반복된
 * "조용한 실패" 패턴 그대로다. 그래서 기본값은 항상 실재하는 신규 축 파일이다.
 */
export function groupsPath(cfg) {
  const rel = cfg?.channel?.groups_file || 'config/cardnews-groups.txt';
  return process.env.CARDNEWS_GROUPS_OVERRIDE || join(REPO_ROOT, rel);
}
export function bannedTermsPath() {
  return process.env.CARDNEWS_BANNED_OVERRIDE || join(REPO_ROOT, 'config', 'cardnews-banned-terms.txt');
}

/** `#` 주석·빈 줄 제거 후 줄 배열. 파일 부재는 `[]`(게이트가 죽지 않는다 — 아래 참조). */
export function loadLines(path) {
  if (!existsSync(path)) {
    log.warn(`패턴 파일 없음 → 해당 축 검사 생략: ${path}`);
    return [];
  }
  return readFileSync(path, 'utf8').split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
}

/** 줄 배열 → 컴파일된 정규식 배열. 컴파일 실패 줄은 graceful skip(전체를 죽이지 않는다). */
function compileEach(lines, flags = 'g') {
  const out = [];
  for (const term of lines) {
    try { out.push({ term, re: new RegExp(term, flags) }); }
    catch (e) { log.warn(`패턴 컴파일 실패 [${term}]: ${e.message}`); }
  }
  return out;
}

/**
 * 사람 축 → 하나의 alternation 조각. 컴파일 가능성을 줄 단위로 먼저 검증해, 한 줄이 상해도
 * 나머지 축 항목이 살아남게 한다.
 */
function axisAlternation(lines) {
  const ok = [];
  for (const l of lines) {
    try { new RegExp(l); ok.push(l); }
    catch (e) { log.warn(`축 패턴 컴파일 실패 [${l}]: ${e.message}`); }
  }
  return ok.join('|');
}

// ── 규칙 조립 ────────────────────────────────────────────────────────────────

/**
 * TIER-1/TIER-2 규칙 세트 조립.
 * @param {object} p {groups: string[], banned: string[]}
 */
export function buildRules({ groups = [], banned = [] } = {}) {
  const G = axisAlternation(groups);
  const tier1 = [];

  if (G) {
    // G1 전칭 일반화 — "여자들은 다…", "INFP는 항상…", "20대는 원래…"
    tier1.push({ id: 'G1', label: '전칭 일반화', re: new RegExp(`${NOT_INDIVIDUAL}(?:${G})\\s*${GROUP_MARK}\\s*(?:${ALL_ADV})`, 'g') });
    // G2 본질화 — 창 40자. 좁히면 미탐(수식어가 끼면 놓친다), 넓히면 문장을 넘어 오탐.
    tier1.push({ id: 'G2', label: '본질화', re: new RegExp(`${NOT_INDIVIDUAL}(?:${G})\\s*${GROUP_MARK}[^.!?\\n]{0,40}(?:${ESSENCE_G2})`, 'g') });
    // G3 우열 비교 — "여자보다 남자가 열등…"
    tier1.push({ id: 'G3', label: '우열 비교', re: new RegExp(`(?:${G})[^.!?\\n]{0,30}보다[^.!?\\n]{0,20}(?:${SUPERIORITY})`, 'g') });
    // G4 본성 단정 — 구 G4(국민성 단정)의 축 교체판. `은/는` 이 아니라 `의` 로 이어지는
    // 형태라 G2 의 창에 걸리지 않는다("남자의 본성은 …"). 국명 축에서 `국민성|민족성` 이
    // 하던 자리를 사람 축에서는 `본성|천성|기질|성향|특성` 이 맡는다.
    tier1.push({ id: 'G4', label: '본성 단정', re: new RegExp(`(?:${G})\\s*(?:의\\s*)?(?:본성|천성|기질|성향|특성)(?:은|는|이|가)`, 'g') });
    // G6 사람 주어 자체 — 부사를 요구하지 않는다.
    //
    // 🔴 실측(2026-07-31): G1·W1 은 전칭 부사(다·원래·항상…)가 있어야만 발동한다. 그래서
    // 부사 하나만 빼면 전형적인 고정관념이 그대로 통과했다:
    //   "여자들은 감정적이다" → PASS · "남자는 표현을 못 한다" → PASS
    //   "남자는 원래 표현을 못 한다" → BLOCK
    // 삭제 불가능한 공개 계정에 나가는 걸 막으려고 만든 게이트인데, 정작 부사 없는 형태에는
    // 기계적 방어가 없고 작가 프롬프트(LLM 지시)만 남아 있었다.
    //
    // 축이 바뀌어도 이 규칙의 값어치는 그대로다. 이 채널이 다루는 것은 **한 사람의 상황**
    // ("연락이 뜸해진 사이")이지 **집단의 속성**("남자는 …")이 아니다. 집단을 주어로 잡는
    // 문장은 사실 서술이든 성향 단정이든 이 채널에서 쓸 자리가 없다 — 오탐이 아니라 교정
    // 신호다. 개인 지칭("그 남자는")은 NOT_INDIVIDUAL 이 빼고 TIER-2 로 넘긴다.
    tier1.push({ id: 'G6', label: '사람 주어 일반화', re: new RegExp(`${NOT_INDIVIDUAL}(?:${G})\\s*${GROUP_MARK}\\s`, 'g') });
  } else {
    log.warn('사람 축 목록이 비어 TIER-1 G1~G4·G6 비활성 — 비하어(G5)만 검사한다');
  }

  // G5 비하어 — 목록 직접 매칭. 맥락 판단 없음(의도된 설계).
  for (const { term, re } of compileEach(banned)) {
    tier1.push({ id: 'G5', label: `비하어(${term})`, re });
  }

  const tier2 = [
    // W1 은 DEMONYM_RE + 스톱리스트라 별도 처리(아래 scanTier2).
    //
    // W2 지시대명사 일반화 — 축 토큰이 **없는** 복수 주어만 본다. `남자들|여자들` 을 넣지
    // 않는 이유: 그건 축이 있으므로 TIER-1 이 이미 차단한다(경고로 중복 기록할 이유가 없다).
    // 복수형을 요구하는 이유: "그 사람은 원래 그런 사람이었어" 는 개인 이야기이고 이
    // 버티컬에서 매일 쓰이는 문장이라, 경고로도 잡으면 큐가 잡음으로 차서 아무도 안 읽는다.
    { id: 'W2', label: '지시대명사 일반화', re: new RegExp(`(?:그런|이런|저런|그|이|저)\\s*(?:부류|유형|타입|스타일)?\\s*(?:사람들|애들|남들)(?:은|는)\\s*(?:${ALL_ADV})`, 'g') },
  ];

  return { tier1, tier2, hasGroups: Boolean(G) };
}

/** 문장 분할 — W3(장거리 본질화)는 창 길이가 아니라 문장 경계로 판정한다. */
function sentences(text) {
  return String(text ?? '').split(/(?<=[.!?…])\s+|\n+/).map(s => s.trim()).filter(Boolean);
}

// ⚠ 주체어에 `민족` 을 넣지 않는다 — W3 는 같은 문장 공존만 보므로 주체어와 본질화 어휘가
//   같은 토큰이면 그 토큰 하나가 스스로 경고를 만든다.
// 사람 축 전환에 맞춰 `남자|여자|인간|애들` 을 더했다. 이들은 조사가 `은/는` 이 아닐 때
// (`남자가` · `여자를`) TIER-1 을 빠져나가는데, 본질화 어휘와 한 문장에 있으면 여전히
// 고정관념이다 — 그 구멍을 경고로 받는 것이 W3 의 원래 존재 이유다.
const W3_SUBJECT = /사람들?|국민|주민|남자|여자|남성|여성|인간|애들/;
const W3_ESSENCE = new RegExp(ESSENCE_W3);

// ── 스캔 ─────────────────────────────────────────────────────────────────────

const snippet = (m) => String(m).replace(/\s+/g, ' ').slice(0, 80);

function scanTier1(text, rules) {
  const hits = [];
  for (const r of rules) {
    r.re.lastIndex = 0;
    let m;
    while ((m = r.re.exec(text)) !== null) {
      hits.push({ rule: r.id, label: r.label, match: snippet(m[0]) });
      if (m.index === r.re.lastIndex) r.re.lastIndex++;   // 영길이 매칭 무한루프 방지
    }
  }
  return hits;
}

function scanTier2(text, rules) {
  const warns = [];

  // W1 — 국민호칭 단독. 접미사 판정이라 스톱리스트로 무관어를 걷어낸다.
  DEMONYM_RE.lastIndex = 0;
  let m;
  while ((m = DEMONYM_RE.exec(text)) !== null) {
    if (!NON_DEMONYM.has(m[1])) warns.push({ rule: 'W1', label: '국민호칭 단독 일반화', match: snippet(m[0]) });
    if (m.index === DEMONYM_RE.lastIndex) DEMONYM_RE.lastIndex++;
  }

  // W2 — 지시대명사.
  for (const r of rules) {
    r.re.lastIndex = 0;
    let mm;
    while ((mm = r.re.exec(text)) !== null) {
      warns.push({ rule: r.id, label: r.label, match: snippet(mm[0]) });
      if (mm.index === r.re.lastIndex) r.re.lastIndex++;
    }
  }

  // W3 — 장거리 본질화. 같은 **문장** 안에 주체어와 본질화 어휘가 공존하면 창 길이 무관.
  for (const s of sentences(text)) {
    if (W3_SUBJECT.test(s) && W3_ESSENCE.test(s)) {
      warns.push({ rule: 'W3', label: '장거리 본질화', match: snippet(s) });
    }
  }
  return warns;
}

/**
 * 텍스트 조각 배열을 검사한다. 조각별로 돌리는 이유: 카드 경계를 넘어선 우연한 인접이
 * 오탐을 만들지 않게 하고, 히트가 어느 필드에서 났는지 리뷰큐에 남기기 위해서다.
 *
 * @param {Array<{field:string, text:string}>} parts
 * @returns {{pass:boolean, reason:string, evidence:{tier1_hits:Array, tier2_warnings:Array}}}
 */
export function checkParts(parts, rules) {
  const tier1_hits = [];
  const tier2_warnings = [];
  for (const { field, text } of parts) {
    if (!text) continue;
    for (const h of scanTier1(text, rules.tier1)) tier1_hits.push({ field, ...h });
    for (const w of scanTier2(text, rules.tier2)) tier2_warnings.push({ field, ...w });
  }
  const pass = tier1_hits.length === 0;
  const reason = pass
    ? (tier2_warnings.length ? `TIER-2 경고 ${tier2_warnings.length}건(비차단)` : '이상 없음')
    : `TIER-1 차단 ${tier1_hits.length}건: ${tier1_hits.map(h => `${h.rule}@${h.field}`).join(', ')}`;
  return { pass, reason, evidence: { tier1_hits, tier2_warnings } };
}

/**
 * §3.6 대본 스키마 → 검사 대상 텍스트 조각.
 * 대상: cover(headline·sub) + cards[](headline·body) + outro(headline·body) + caption_sections 전문.
 * 해시태그는 제외한다 — `#일본문화` 같은 태그는 조사가 붙지 않아 규칙이 애초에 발화하지 않고,
 * 넣으면 W1 접미사 판정에 잡음만 늘린다.
 */
export function collectParts(script = {}) {
  const parts = [];
  const push = (field, text) => { if (typeof text === 'string' && text.trim()) parts.push({ field, text }); };

  push('cover.headline', script.cover?.headline);
  push('cover.sub', script.cover?.sub);
  const cards = Array.isArray(script.cards) ? script.cards : [];
  cards.forEach((c, i) => {
    push(`cards[${c?.index ?? i + 1}].headline`, c?.headline);
    push(`cards[${c?.index ?? i + 1}].body`, c?.body);
  });
  push('outro.headline', script.outro?.headline);
  push('outro.body', script.outro?.body);
  for (const k of ['hook', 'body', 'cta']) push(`caption_sections.${k}`, script.caption_sections?.[k]);
  return parts;
}

/** 설정에서 규칙을 조립한다(파일 I/O 포함). 테스트는 `buildRules` 를 직접 쓴다. */
export function rulesFromConfig(cfg) {
  return buildRules({
    groups: loadLines(groupsPath(cfg)),
    banned: loadLines(bannedTermsPath()),
  });
}

/**
 * TIER-2 히트를 리뷰 큐에 append.
 *
 * `gate` 는 인자로 뺀다 — 인용·정신건강 게이트(`gate-quote.mjs`)가 같은 큐를 쓰되 어느
 * 게이트가 남긴 경고인지 구분할 수 있어야 한다(월간 요약이 규칙별로 쪼갠다).
 *
 * `reviewed_at: null` 을 **처음부터 필드로 넣는다** — 없는 키는 "아직 안 봤다"와 "이 스키마를
 * 모른다"를 구분하지 못하고, §3.19 의 적체 감시(`stale_review_days`)가 그 구분 위에 서 있다.
 * 기록 실패는 비차단(경고만) — 리뷰 큐 append 실패로 통과한 대본을 버리지 않는다.
 */
export function appendReviewQueue(postId, warnings, { now = new Date(), gate = GATE_NAME } = {}) {
  if (!warnings.length) return null;
  const row = {
    at: now.toISOString(),
    post_id: postId ?? null,
    gate,
    count: warnings.length,
    warnings,
    reviewed_at: null,
  };
  try {
    mkdirSync(stateRoot(), { recursive: true });
    appendFileSync(reviewQueuePath(), JSON.stringify(row) + '\n', 'utf8');
  } catch (e) {
    log.warn(`review-queue.jsonl 기록 실패(비차단): ${e.message}`);
    return null;
  }
  return row;
}

// ── 리뷰 큐 수명주기 ─────────────────────────────────────────────────────────

/** 자동만료 마커 — `reviewed_at` 이 사람 검토인지 자동만료인지 구분하는 유일한 근거. */
export const AUTO_REVIEWED_MARK = '무검토 자동통과';

/**
 * review-queue.jsonl 전체 파싱. `loadBacklog`/`loadRuns`(lib.mjs) 와 같은 정책 — **깨진 줄은
 * 건너뛴다**(전체를 포기하지 않는다). 여기서는 malformed 개수도 함께 돌려준다(§review 만료가
 * "세되 죽지 않는다"를 보이려면 그 개수가 필요하다).
 */
export function loadReviewQueue() {
  const p = reviewQueuePath();
  if (!existsSync(p)) return { rows: [], malformed: 0 };
  const lines = readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean);
  const rows = [];
  let malformed = 0;
  for (const l of lines) {
    try {
      const row = JSON.parse(l);
      rows.push(row);
    } catch (e) {
      malformed++;
      log.warn(`review-queue.jsonl 손상 줄 건너뜀: ${e.message}`);
    }
  }
  return { rows, malformed };
}

/**
 * `auto_expire_days` 지난 미검토(`reviewed_at===null`) 항목을 `reviewed_at`+`auto_reviewed` 로
 * 검토완료 처리한다. **다른 필드는 전부 보존**하고, 이미 검토된 행은 손대지 않는다.
 *
 * 원자적 재기록 — tmp 쓰기 → rename(`lib.mjs saveIndexAtomic` 관례, `state/cardnews/*.tmp` 는
 * gitignore 됨). 만료 대상이 0건이면 파일을 건드리지 않는다(불필요한 rename 을 피한다).
 *
 * **절대 throw 하지 않는다** — 손상 줄은 `loadReviewQueue` 가 세어서 건너뛰고, 모양이
 * object 가 아닌 행(예: `null`)은 그대로 통과시킨다(만료 대상에서 제외할 뿐 파일에는 남긴다).
 *
 * @returns {{expired:number, remaining:number, skipped:number}} remaining = 이번 런 뒤에도
 *   여전히 `reviewed_at===null` 인 행 수(= 아직 기한이 안 된, 사람을 기다리는 항목).
 */
export function expireStaleReviews({ cfg = null, now = new Date() } = {}) {
  const conf = cfg || loadConfig();
  const days = Number.isFinite(conf?.review?.auto_expire_days) ? conf.review.auto_expire_days : 14;
  const { rows, malformed } = loadReviewQueue();
  if (!rows.length) return { expired: 0, remaining: 0, skipped: malformed };

  const cutoff = now.getTime() - days * 24 * 3600 * 1000;
  let expired = 0;
  const out = rows.map((row) => {
    if (!row || typeof row !== 'object' || row.reviewed_at != null) return row;
    const at = typeof row.at === 'string' ? Date.parse(row.at) : NaN;
    if (!Number.isFinite(at) || at > cutoff) return row;
    expired++;
    return { ...row, reviewed_at: now.toISOString(), auto_reviewed: AUTO_REVIEWED_MARK };
  });

  if (expired > 0) {
    const p = reviewQueuePath();
    mkdirSync(stateRoot(), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, out.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    renameSync(tmp, p);
  }

  const remaining = out.filter(r => r && typeof r === 'object' && r.reviewed_at == null).length;
  return { expired, remaining, skipped: malformed };
}

/**
 * `auto_pause_on_stale` 정책 자체를 값으로 노출한다. §3.19 의 자동 강등 기전은 어디에도
 * 배선돼 있지 않다(Step 6 소관, 여기서 구현하지 않는다) — 그래서 이 함수는 어떤 동작도
 * 일으키지 않는 **순수 조회**다. 존재 이유는 하나: `auto_pause_on_stale=false` 라는 설정이
 * "미검토 적체가 아무리 쌓여도 정지 신호를 만들지 않는다"는 결정을 코드로 증명하는 것.
 *
 * `stale_review_days` 를 기준으로 삼는다(§review 의 원래 정지 임계값 — `auto_expire_days` 와
 * 값이 같을 수 있지만 개념은 다르다: 하나는 "언제 정지할 뻔했나", 하나는 "언제 큐에서 내리나").
 */
export function checkAutoPauseSignal({ cfg = null, rows = null, now = new Date() } = {}) {
  const conf = cfg || loadConfig();
  const thresholdDays = Number.isFinite(conf?.review?.stale_review_days) ? conf.review.stale_review_days : 14;
  const list = rows || loadReviewQueue().rows;
  const cutoff = now.getTime() - thresholdDays * 24 * 3600 * 1000;
  const stale = list.filter((r) => {
    if (!r || typeof r !== 'object' || r.reviewed_at != null) return false;
    const at = typeof r.at === 'string' ? Date.parse(r.at) : NaN;
    return Number.isFinite(at) && at <= cutoff;
  });
  const enabled = conf?.review?.auto_pause_on_stale === true;
  return { enabled, stale_count: stale.length, would_pause: enabled && stale.length > 0, threshold_days: thresholdDays };
}

/**
 * 달력월 요약 — 그 달에 쌓인 TIER-2 히트 전체, 규칙별 분해, 자동만료/사람검토 갈래, 그리고
 * 자동만료된 것 중 표본 문장(사람이 "실제로 뭐가 검수 없이 나갔는지" 볼 수 있는 것이 이
 * 요약의 존재 이유다). **notify() 로 보내지 않는다** — 발송 배선은 Step 6(`scripts/notify/**`)
 * 소관, 이 함수는 데이터와 포매터만 내놓는다.
 *
 * @param {object} p
 * @param {object} [p.cfg]
 * @param {Date} [p.now]
 * @param {string} [p.month] `YYYY-MM`(KST). 생략 시 `now` 가 속한 달.
 * @param {number} [p.sampleLimit] 자동만료 표본 문장 최대 개수(기본 5).
 */
export function monthlyDigest({ cfg = null, now = new Date(), month = null, sampleLimit = 5 } = {}) {
  const conf = cfg || loadConfig();
  const targetMonth = month && /^\d{4}-\d{2}$/.test(month) ? month : kstDate(now).slice(0, 7);
  const { rows } = loadReviewQueue();
  const inMonth = rows.filter(r => r && typeof r === 'object' && typeof r.at === 'string'
    && kstDate(new Date(r.at)).slice(0, 7) === targetMonth);

  const byRule = new Map();
  let totalHits = 0;
  for (const row of inMonth) {
    for (const w of (Array.isArray(row.warnings) ? row.warnings : [])) {
      totalHits++;
      const key = `${w?.rule}::${w?.label ?? ''}`;
      const cur = byRule.get(key) || { rule: w?.rule ?? null, label: w?.label ?? null, count: 0 };
      cur.count++;
      byRule.set(key, cur);
    }
  }

  const autoExpired = inMonth.filter(r => r.auto_reviewed === AUTO_REVIEWED_MARK);
  const humanReviewed = inMonth.filter(r => r.reviewed_at != null && r.auto_reviewed !== AUTO_REVIEWED_MARK);
  const pending = inMonth.filter(r => r.reviewed_at == null);

  const samples = [];
  outer:
  for (const row of autoExpired) {
    for (const w of (Array.isArray(row.warnings) ? row.warnings : [])) {
      if (samples.length >= sampleLimit) break outer;
      samples.push({ post_id: row.post_id ?? null, rule: w?.rule ?? null, label: w?.label ?? null, field: w?.field ?? null, match: w?.match ?? null, at: row.at });
    }
  }

  return {
    month: targetMonth,
    total_posts: inMonth.length,
    total_hits: totalHits,
    by_rule: [...byRule.values()].sort((a, b) => b.count - a.count),
    auto_expired: autoExpired.length,
    human_reviewed: humanReviewed.length,
    pending: pending.length,
    samples,
    pause_signal: checkAutoPauseSignal({ cfg: conf, rows, now }),
  };
}

/** `monthlyDigest()` 결과 → 사람이 읽는 평문(발송 배선은 호출자 몫). */
export function formatDigestText(digest) {
  const lines = [];
  lines.push(`[카드뉴스 TIER-2 월간 요약] ${digest.month}`);
  lines.push(`총 히트 ${digest.total_hits}건(대상 글 ${digest.total_posts}건) — 자동만료 ${digest.auto_expired}건 · 사람검토 ${digest.human_reviewed}건 · 미검토 ${digest.pending}건`);
  if (digest.by_rule.length) {
    lines.push('규칙별:');
    for (const r of digest.by_rule) lines.push(`  - ${r.rule}(${r.label ?? '-'}): ${r.count}건`);
  }
  lines.push(digest.pause_signal.enabled
    ? `⚠ auto_pause_on_stale=true — 미검토 적체 ${digest.pause_signal.stale_count}건${digest.pause_signal.would_pause ? '(정지 조건 충족)' : ''}`
    : `auto_pause_on_stale=false — 미검토 적체 ${digest.pause_signal.stale_count}건이 있어도 채널은 멈추지 않는다(리스크 수용, 자동만료로 대체).`);
  if (digest.samples.length) {
    lines.push('자동만료 표본(사람 눈 없이 나간 문장):');
    for (const s of digest.samples) lines.push(`  - [${s.rule}] ${s.match ?? ''} (post=${s.post_id ?? '-'})`);
  }
  return lines.join('\n');
}

/**
 * 대본 1건 판정. **렌더 전**(대본 직후)에 호출한다 — Playwright·Supabase 비용을 태우기 전에
 * 막는 것이 이 게이트의 배치 이유다.
 */
export function runGate(script, { cfg = null, rules = null, postId = null, appendQueue = true } = {}) {
  const conf = cfg || loadConfig();
  const rs = rules || rulesFromConfig(conf);
  const result = checkParts(collectParts(script), rs);
  const pid = postId || script?.post_id || null;
  if (appendQueue && result.evidence.tier2_warnings.length) {
    appendReviewQueue(pid, result.evidence.tier2_warnings);
  }
  return { gate: GATE_NAME, post_id: pid, ...result };
}

/** 문장 1줄 판정(코퍼스·디버그용 — 리뷰큐를 건드리지 않는다). */
export function runGateOnLine(line, { cfg = null, rules = null } = {}) {
  const rs = rules || rulesFromConfig(cfg || loadConfig());
  const result = checkParts([{ field: 'line', text: String(line) }], rs);
  return { gate: GATE_NAME, post_id: null, ...result };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);

  // ── 큐 수명주기 모드 — pass/fail 게이트가 아니다: exit 0=완료, 2=실행오류(exit 1 미사용). ──
  const expireIdx = argv.indexOf('--expire');
  if (expireIdx >= 0) {
    try {
      const r = expireStaleReviews({});
      process.stdout.write(JSON.stringify({ mode: 'expire', ...r }) + '\n');
      process.exit(0);
    } catch (e) {
      process.stdout.write(JSON.stringify({ mode: 'expire', error: e.message }) + '\n');
      process.stderr.write(`review-queue 만료 실행 오류: ${e.message}\n`);
      process.exit(2);
    }
  }

  const digestIdx = argv.indexOf('--digest');
  if (digestIdx >= 0) {
    const monthArg = argv[digestIdx + 1];
    const month = monthArg && /^\d{4}-\d{2}$/.test(monthArg) ? monthArg : null;
    try {
      const digest = monthlyDigest({ month });
      process.stdout.write(JSON.stringify({ mode: 'digest', ...digest }) + '\n');
      process.stderr.write(formatDigestText(digest) + '\n');
      process.exit(0);
    } catch (e) {
      process.stdout.write(JSON.stringify({ mode: 'digest', error: e.message }) + '\n');
      process.stderr.write(`월간 요약 실행 오류: ${e.message}\n`);
      process.exit(2);
    }
  }

  const lineIdx = argv.indexOf('--line');
  const postIdx = argv.indexOf('--post-id');
  const postId = postIdx >= 0 ? argv[postIdx + 1] : null;

  let result;
  try {
    if (lineIdx >= 0) {
      const line = argv[lineIdx + 1];
      if (line == null) { process.stderr.write('사용법: gate-generalization.mjs --line "<문장>"\n'); process.exit(2); }
      result = runGateOnLine(line);
    } else {
      // 위치 인자 = `--` 플래그도, 플래그의 값도 아닌 첫 토큰. `indexOf` 로 앞 토큰을 찾으면
      // 같은 문자열이 두 번 나올 때 첫 위치를 돌려줘 오판하므로 인덱스로 훑는다.
      let file = null;
      for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith('--')) { i++; continue; }   // 플래그 + 그 값을 건너뛴다
        file = argv[i]; break;
      }
      if (!file) { process.stderr.write('사용법: gate-generalization.mjs <script.json> [--post-id cn-…] | --line "<문장>" | --expire | --digest [YYYY-MM]\n'); process.exit(2); }
      const script = JSON.parse(readFileSync(resolve(file), 'utf8'));
      result = runGate(script, { postId });
    }
  } catch (e) {
    // exit 2 = 실행오류. 판정 실패를 "통과"로도 "차단"으로도 보고하지 않는다.
    process.stdout.write(JSON.stringify({ gate: GATE_NAME, pass: false, error: e.message }) + '\n');
    process.stderr.write(`게이트 실행 오류: ${e.message}\n`);
    process.exit(2);
  }

  process.stdout.write(JSON.stringify(result) + '\n');   // stdout 은 JSON 정확히 1줄
  for (const h of result.evidence.tier1_hits) log.warn(`TIER-1 ${h.rule} @${h.field}: ${h.match}`);
  for (const w of result.evidence.tier2_warnings) log.warn(`TIER-2 ${w.rule} @${w.field}: ${w.match}`);
  process.exit(result.pass ? 0 : 1);
}

if (isMainModule(import.meta.url)) main();
