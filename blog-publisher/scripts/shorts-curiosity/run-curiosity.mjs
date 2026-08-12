#!/usr/bin/env node
/**
 * shorts-curiosity/run-curiosity.mjs — 일일 오케 (백로그→선정→검증→JIT제작→큐)
 *
 * 사용: node scripts/shorts-curiosity/run-curiosity.mjs
 *
 * ① 백로그가 부족하면 보충(경량) ② 반전·호기심 강도 best-pick ③ 가벼운 사실확인
 * (ok 아니면 보류하고 다음 후보) ④ 선정 1건만 풀 제작(shorts 엔진) ⑤ 게이트→pending 큐.
 * 토큰 효율: 풀 제작은 선정 1건에만. 계약: stdout JSON. exit 0/1(게이트fail)/2(오류)
 *
 * AC-8(best_n): config.pick.best_n 으로 하루 병행 제작 편수를 정한다(A/B용).
 * best_n=1(기본)은 위 단일 경로와 완전히 동일(회귀 금지). best_n>=2 면 pickTopN 상위
 * 후보를 순차로 factcheck→제작→큐→업로드해 최대 N편을 병행 산출한다(서로 다른 subject로
 * 다양성 확보).
 *
 * NOTE: 성과 피드백은 별도 analytics-collect/self-evolve 경로가 맡는다. 이 오케스트레이터는
 * 수집을 인라인 실행하지 않으며, 수집 불가 시 현재 config 운영정책을 그대로 적용한다.
 */
import { copyFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeLogger } from '../lib/log.mjs';
import { loadConfig, loadIndex, loadBacklog, pendingBacklog, markStatus, slugify, isMainModule } from './lib.mjs';
import { refillBacklog } from './backlog.mjs';
import { pick, pickTopN, stripJosa } from './pick.mjs';
import { factCheck, applyCorrection } from './factcheck.mjs';
import { generateScript } from './script.mjs';
import { checkDiversity } from './diversity.mjs';
import { produceFromScript } from '../shorts/produce.mjs';
import { uploadVideo } from '../shorts/upload.mjs';
import { pendingDir, ensureDirs, workDir } from '../shorts/lib.mjs';
import { recordUploadedVideo } from './video-record.mjs';
import { isUploadableInventory } from './inventory.mjs';

const log = makeLogger('curiosity/run');

/** angle 별 태그·해시태그. whatif 는 사실 폭로가 아닌 '만약 ~였다면?' 사고실험이라 reveal 앵글의
 *  "#설마진짜" 라벨로 나가면 안 된다(공개 채널 오라벨 방지). buildUploadMeta·재고 폴백 공용. */
function angleLabels(angle, domain) {
  const isWhatIf = angle === 'whatif';
  return {
    tags: (isWhatIf
      ? ['만약에', '가정해보기', '사고실험', '호기심', 'shorts', domain]
      : ['설마진짜', '지식', '호기심', 'shorts', domain]).filter(Boolean),
    hashtags: isWhatIf ? '#만약에 #가정 #호기심 #shorts' : '#설마진짜 #지식 #호기심 #shorts',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// US-010 팩트체크 정정 게이트 — "사실이지만 숫자가 틀렸다"를 새어나가지 않게 한다.
//
// 2026-07-30 실사고: badger 가 note 에 "제목의 '13억 원'은 자릿수 오류…반드시 수정할 것"을
// 적었는데 verdict=ok 라 그대로 유튜브에 올라갔다. 이제 판정을 세 갈래로 해석한다:
//   ① verdict≠ok            → 보류(기존과 동일)
//   ② ok + 정정 필요 + 정정본 → **정정본으로 subject/reveal 을 대체**해 발행(대본·제목까지 반영)
//   ③ ok + 정정 필요 + 정정 불가 → **보류**(알려진 오류를 내보내지 않는다. 슬롯은 다음 후보·재고·
//      상한완화 경로가 채운다 — 하루 3편 룰은 그대로 유지된다)
// 보류 사유를 `factcheck:` 접두로 유지하는 이유: lib.mjs pendingBacklog 이 factcheck 계열 보류를
// factcheck_fails>=2 에서 재선정 제외한다 → 정정 불가 아이템이 매 슬롯 pick 을 독점하지 않는다.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 팩트체크 결과 1건을 발행/보류 결정으로 변환. 두 경로(단일·best_n>=2)가 공유하는 단일 판정부.
 * @returns { action:'publish'|'hold', item, corrected, reason, note, log }
 */
export function resolveFactcheck(item, fc = {}) {
  if (fc.verdict !== 'ok') {
    return { action: 'hold', reason: `factcheck:${fc.verdict}`, note: fc.note || '', log: `사실확인 ${fc.verdict}` };
  }
  const corr = applyCorrection(item, fc);
  if (!corr.applied) {
    return {
      action: 'hold',
      reason: 'factcheck:correction-unapplicable',
      note: `정정 적용 불가(${corr.reason}) :: ${fc.note || ''}`,
      log: `사실확인 ok 이나 정정 적용 불가(${corr.reason}) — 알려진 오류 발행 방지`,
    };
  }
  return { action: 'publish', item: corr.item, corrected: corr.changed, reason: 'ok', note: fc.note || '', log: 'ok' };
}

// ─────────────────────────────────────────────────────────────────────────────
// 백로그 보충 임계 — 앵글 편중의 실제 원인이었던 "고갈 직전 보충"을 없앤다.
//
// 실측(2026-07-30, 선정점수 42건): reveal 평균 0.816(n=31) vs whatif 0.817(n=11) — 두 앵글
// 점수는 사실상 동일하다. 즉 편중은 앵글 선호가 아니라 **보충 타이밍의 함수**였다. 기존
// 임계가 `Math.min(target_size, 5)` = 잔여 5건 미만이라, 배치(10건) 중 고득점 reveal 이
// 먼저 소진되고 바닥에 whatif 가 농축된 상태로 2~3일을 버텼다(07-27 전부 reveal → 07-28
// 전부 whatif → 07-29 보충 직후 reveal 복귀).
//
// 따라서 임계를 "며칠치 소비분(daily_target × refill_buffer_days)"으로 올려 바닥을 긁지
// 않게 한다. ⚠ 보충은 claude -p 비용이 있으나 소비량이 일정(3편/일)하므로 보충 **빈도**는
// 임계와 무관하다(배치 10건 ÷ 3편 ≈ 3일에 1회) — 임계는 풀의 수위만 올린다. 매 슬롯 무조건
// 보충 같은 건 하지 않는다.
// ─────────────────────────────────────────────────────────────────────────────

/** 보충 임계(잔여 건수). config.backlog.refill_threshold 우선, 없으면 daily_target×버퍼일수. */
export function refillThreshold(cfg = {}) {
  const target = cfg.backlog?.target_size ?? 50;
  const explicit = cfg.backlog?.refill_threshold;
  if (Number.isFinite(explicit)) return Math.max(0, Math.min(target, Math.floor(explicit)));
  const daily = Number.isFinite(cfg.pick?.daily_target) ? cfg.pick.daily_target : 3;
  const days = Number.isFinite(cfg.backlog?.refill_buffer_days) ? cfg.backlog.refill_buffer_days : 4;
  return Math.max(1, Math.min(target, Math.ceil(daily * days)));
}

/** 잔여 후보가 버퍼 미달이면 보충 트리거. */
export function needsRefill(pendingCount, cfg = {}) {
  return Number(pendingCount) < refillThreshold(cfg);
}

// ─────────────────────────────────────────────────────────────────────────────
// US-004 업로드 메타 — 제목 40자 컷·역링크·구독 CTA·주제 태그(유입 극대화)
// 테스트: scripts/test/curiosity-upload-meta.test.mjs
// ─────────────────────────────────────────────────────────────────────────────

/** 제목 본문 상한(자). Shorts 피드는 이보다 길면 절삭돼 CTR 을 깎는다. */
const TITLE_BODY_MAX = 40;
/** 의미는 거의 없고 길이만 먹는 군더더기(축약 1순위). */
const TITLE_FILLERS = ['내일', '전부', '아예', '딱', '끝내', '정말', '과연', '실제로', '도대체', '굳이', '진짜로', '무려'];
/**
 * 태그 키워드에서 걸러낼 기능어·상투어.
 * 실측(2026-07-30 12시 슬롯): "법정에서 그림을 직접 그려 자기 작품임을 증명한 화가" 를 어절로
 * 쪼개 `직접·그려·자기·작품임·증명한·세계적` 이 그대로 태그가 됐다 — 아무도 검색하지 않는
 * 조각이 15개 상한을 잡아먹어 정작 필요한 고유명사(마거릿 킨·명예훼손)를 밀어냈다.
 */
const TAG_STOPWORDS = new Set(['만약', '정말', '과연', '진짜', '그리고', '하지만', '그런데', '우리', '있는', '없는', '무슨', '어디서', '어떻게', '가장',
  '먼저', '전부', '내일', '아예', '모두', '사람', '사실', '이유', '그것', '때문', '한다면', '했다면', '된다면', '이라면', '라면', '일까', '까지', '동안',
  '위해', '대한', '지금', '오늘', '실제', '경우', '수도', '거의', '바로', '가지', '것도', '다면', 'shorts',
  // 부사·대명사·수식어(검색어 가치 0)
  '직접', '자기', '자신', '매우', '아주', '무척', '너무', '조금', '거의', '겨우', '결국', '오히려', '심지어', '함께', '서로', '스스로', '각자',
  '당시', '이후', '이전', '처음', '마지막', '대부분', '일부', '하나', '이것', '저것', '여기', '거기', '어제', '요즘', '항상', '이미', '아직',
  '그때', '나중', '다음', '전체', '온갖', '무려', '실은', '역시', '물론', '특히', '반면', '따라서', '그래서', '때문에',
  '그대로', '그대', '마찬가지', '여전히', '다시', '이제', '그냥', '아마', '어쩌면', '심하', '가까이', '무조건',
  // 추상 명사(어떤 주제에나 붙어 변별력이 없다)
  '정도', '부분', '상황', '방법', '문제', '이야기', '내용', '결과', '사이', '모습', '느낌', '생각', '기분', '차이', '종류', '수준']);
/** 태그가 8개에 못 미칠 때만 쓰는 보충(채널 공통 검색어 — 조각이 아니라 실제로 쓰이는 말). */
const TAG_PADDING = ['쇼츠', '흥미로운사실', '알쓸신잡', '생활상식', '트리비아', '몰랐던사실'];

/**
 * 유입용 사이트 베이스 URL.
 * 우선순위: CURIOSITY_SITE_BASE_URL > SITE_BASE_URL > 운영 도메인(www.thundo.kr).
 * ⚠ .env 의 SITE_BASE_URL 은 배포 폴링(wait-deploy)용으로 vercel 프리뷰 도메인이 들어있을 수
 *   있다 — 설명란 역링크를 캐노니컬 도메인으로 고정하려면 CURIOSITY_SITE_BASE_URL 을 쓴다.
 */
export function siteBaseUrl() {
  const raw = process.env.CURIOSITY_SITE_BASE_URL || process.env.SITE_BASE_URL || 'https://www.thundo.kr';
  return String(raw).trim().replace(/\/+$/, '');
}

const collapse = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** 군더더기 어절 제거(의미 손상 없는 축약). */
function dropFillers(s) {
  return collapse(s).split(' ').filter(w => !TITLE_FILLERS.includes(w.replace(/[,.!?]$/, ''))).join(' ');
}

/** 절 선두로 오면 말이 끊겨 보이는 의존명사·부사(축약 후보에서 제외). */
const DEPENDENT_HEADS = ['동안', '만큼', '때', '뒤', '후', '전', '채', '뿐', '대로', '정도', '까지', '만', '중'];

/**
 * 전제절 축약 후보들 — 선두 어절을 하나씩 떼어내며 짧은 순으로 후보를 만든다.
 * 서술어(끝 어절)는 항상 남기고 최소 2어절은 유지 → "인간이 100년 동안 한숨도 자지 않는다면"
 * → "한숨도 자지 않는다면"처럼 핵심 조건은 살린다(전제 자체를 버리지 않는 게 요점).
 */
function premiseCandidates(premise) {
  const words = collapse(premise).split(' ').filter(Boolean);
  const out = [];
  for (let drop = 0; drop <= Math.max(0, words.length - 2); drop++) {
    const rest = words.slice(drop);
    if (drop > 0 && DEPENDENT_HEADS.includes(rest[0].replace(/[,.?!]$/, ''))) continue;
    out.push(rest.join(' '));
  }
  return out;
}

/** maxLen 에 맞춰 어절 경계 절삭(최후 수단). 꼬리 구두점·대시는 떼고 '…'. */
function truncateAtWord(s, maxLen) {
  const words = collapse(s).split(' ');
  let out = '';
  for (const w of words) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > maxLen - 1) break;
    out = next;
  }
  return (out || collapse(s).slice(0, maxLen - 1)).replace(/[\s,·;—–\-?!]+$/, '') + '…';
}

/**
 * 제목 본문을 maxLen 이내로 정규화. 40자 이내면 원문 그대로 둔다.
 * 길면 ①괄호 보충설명·선두 '만약' 제거 → ②군더더기 축약 → ③전제절 축약("지구에서 곤충이
 * 내일 전부 사라진다면" → "곤충이 사라진다면") → ④그래도 길면 핵심 결과절만 앞세움 →
 * ⑤최후에 어절 절삭. 단순 잘라내기보다 훅(결과절)을 살리는 게 목적이라 순서가 이렇다.
 */
export function shortenTitleBody(subject, maxLen = TITLE_BODY_MAX) {
  const orig = collapse(subject);
  if (!orig || orig.length <= maxLen) return orig;

  let s = dropFillers(collapse(orig.replace(/\s*\([^)]*\)\s*/g, ' ')).replace(/^만약\s+/, ''));
  if (s.length <= maxLen) return s;

  // 마지막 절 경계(쉼표·대시·세미콜론)로 전제/결과를 나눠, 전제를 줄여가며 결과절을 지킨다.
  const m = s.match(/^(.*)([,—–;])\s*([^,—–;]+)$/);
  if (m) {
    const glue = m[2] === ',' ? ', ' : ' ';
    const result = collapse(m[3]);
    for (const p of premiseCandidates(m[1])) {
      const cand = `${p.replace(/[,\s]+$/, '')}${glue}${result}`;
      if (cand.length <= maxLen && cand.length >= 8) return cand;
    }
    if (result.length <= maxLen && result.length >= 12) return result;   // 최후: 결과절(payoff)만
  }
  return truncateAtWord(s, maxLen);
}

/** 서술어·용언 활용형(검색어로 쓸모 없는 태그) — 원형 어절 기준으로 걸러낸다. */
const PREDICATE_END = /(다면|을까|ㄹ까|일까|는다|한다|했다|된다|이다|였다|겠다|았다|었다|습니다|네요|나요|해요|구나|더라|졌다|린다|난다|하다|되다)$/;
/** 3자 이상에서 '다'로 끝나면 용언 종결형(갈렸다·닥친다·주장하다). 2자는 명사 보호(판다·소다). */
const VERB_FINAL_DA = /다$/;
const ADNOMINAL_END = /(치는|하는|되는|지는|이는|나는|가는|오는|주는|받는|먹는|보는|쓰는|드는|기는|리는|우는|추는|같은|남은|던)$/;
/** 연결어미·의존형(태그 가치 0) — '사라지면·인한·통해' 류. */
const CONNECTIVE_END = /(지면|하면|되면|이면|으면|인한|인해|통해|대해|위한|따라|더불)$/;
/** 용언 연결형 — '그려·되어·하여·증명하며' 류. 명사가 이 꼬리로 끝나는 일은 사실상 없다.
 *  ⚠ '해·워' 는 제외했다(오해·피해·이해·타워·파워 같은 실제 명사가 걸린다). '려' 는 '고려'가
 *  희생되지만 '그려·들려·달려' 조각을 막는 값이 더 크다. */
const CONJUGATION_END = /(려|며|면서|토록|어서|아서|든지|거나)$/;
/** 관형형·명사형 용언(증명한·발견된·부러진·빠져나온·감각일) — 3자 이상에서만 적용해
 *  2자 명사(목적·기적·사진·가을·서울)를 보호한다. */
const VERBAL_MODIFIER_END = /(한|된|인|킨|진|린|난|온|은|일|든)$/;
/** '-적' 파생 수식어(세계적·역사적) — 3자 이상에서만(목적·면적·흔적 보호). */
const SUFFIX_JEOK_END = /적$/;
/** 명사형 어미(작품임·증명함·확인됨) → 어간만 남긴다. */
const NOMINALIZER_END = /(임|함|됨)$/;
/** 서술격 조사 계열(킨이었고·아내였다·작가라는) → 어간만 남긴다. */
const COPULA_TAIL = /(이었|이며|이고|이다|이라|였|입니다|이야)[가-힣]*$/;

/** 어절 → 명사 어간(서술격 조사·명사형 어미·조사 절단). '킨이었고'→'킨', '작품임을'→'작품'. */
export function nounStem(raw) {
  let s = String(raw || '').replace(/[^가-힣A-Za-z0-9]/g, '');
  if (!s) return '';
  s = s.replace(COPULA_TAIL, '');
  // 조사는 **한 번만** 뗀다 — 두 번 떼면 '버즈아이가'→'버즈아이'→'버즈아' 처럼 어간을 깎는다.
  s = stripJosa(s);
  if (s.length >= 3) s = s.replace(NOMINALIZER_END, '');
  // '총으로'→(stripJosa '로')→'총으' 처럼 '으로/으며'의 '으'가 남는 경우 정리.
  if (s.length >= 2) s = s.replace(/으$/, '');
  // '눈에는'→'눈에', '몸속에는'→'몸속에' 처럼 조사를 한 번 뗀 뒤 남은 '에' 정리.
  // '에'로 끝나는 명사는 사실상 없어 안전하다('의/로'는 민주주의·고속도로 때문에 건드리지 않는다).
  if (s.length >= 2) s = s.replace(/에$/, '');
  return s;
}

/**
 * 고유명사구의 **뒤 어절** 전용 어간. stripJosa 는 어간이 1자로 줄어드는 절단을 막지만
 * ('킨이'→'킨' 불가), 성씨·직함처럼 1자 고유명사가 실제로 있다. 앞 어절이 이미 조사 없는
 * 이름꼴일 때만 쓰므로 오탐 위험이 낮다.
 */
function nameTailStem(raw) {
  const s = nounStem(raw);
  if (s.length !== 2) return s;
  const cut = s.replace(/(은|는|이|가|을|를|의|와|과|도|만|로|에)$/, '');
  return cut.length >= 1 ? cut : s;
}

/** 어간이 태그로 쓸 만한 명사인가(길이는 호출자가 판단 — 고유명사 1자 예외 때문). */
function isNounish(stem, raw) {
  if (!stem || stem.length > 20) return false;
  if (TAG_STOPWORDS.has(stem.toLowerCase())) return false;
  if (PREDICATE_END.test(raw) || ADNOMINAL_END.test(raw) || CONNECTIVE_END.test(raw)) return false;
  if (CONJUGATION_END.test(stem)) return false;
  if (stem.length >= 3 && (VERBAL_MODIFIER_END.test(stem) || SUFFIX_JEOK_END.test(stem) || SUFFIX_FRAGMENT_END.test(stem))) return false;
  if (stem.length >= 3 && VERB_FINAL_DA.test(stem)) return false;
  return true;
}

/**
 * 이름 앞에 붙는 역할·관계 명사 — 고유명사구의 **선두로 쓰지 않는다**.
 * "아내 마거릿 킨" 에서 '아내 마거릿'을 묶으면 실제 인물명('마거릿 킨')을 놓친다(실측).
 */
const ROLE_NOUNS = new Set(['아내', '남편', '부인', '남자', '여자', '아들', '딸', '형', '누나', '오빠', '언니', '동생', '친구', '이웃',
  '작가', '화가', '감독', '배우', '가수', '교수', '박사', '회장', '사장', '대통령', '선수', '기자', '의사', '변호사', '판사', '요리사',
  '과학자', '연구자', '발명가', '탐험가', '왕', '여왕', '황제', '장군', '병사', '농부', '상인', '주인']);

/** 숫자·연도 토큰(1986년·1960년대·95%) — 실제 검색어라 그대로 살린다. */
const isNumeric = (s) => /^\d/.test(s) && /\d/.test(s);

// ── 명사 증거(positive evidence) 기반 채택 ───────────────────────────────────
// 금지 어미 목록(blocklist)만으로는 한국어 활용의 롱테일을 못 막는다 — 실제 백로그 14건으로
// 검증했을 때 '요동쳐 수·뒤바뀌고·멈추는데·상관없어·제멋대' 같은 조각이 계속 새어나왔다.
// 그래서 반대로 **명사라는 증거가 있는 어절만** 채택한다: 조사·서술격조사가 붙어 있으면 그
// 앞은 명사다. 증거 없는 맨 어절은 '명사+명사' 복합수식 위치(명예훼손 재판에서)에서만 받는다.
// ⚠ 재현율 일부를 포기한다(이미지·편지처럼 용언 어간꼴로 끝나는 명사는 놓칠 수 있다).
// 사용자 지시가 "품질이 개수보다 우선"이고, 부족분은 채널 공통 태그로 채우면 되기 때문이다.

/** 다의성 없는 강한 조사·서술격 조사 — 붙어 있으면 앞부분은 명사로 확정. */
const STRONG_PARTICLE = /(이었|이며|이고|이라는|라는|이라|이다|입니다|에서는|에서|에게|에는|에도|으로|이나|까지|부터|처럼|만큼|보다|마다|조차|밖에|한테|와의|과의)$/;
/** 용언 어미와 형태가 겹치는 1자 조사 — 어간 모양을 추가로 검사해야 한다. */
const WEAK_PARTICLE = /(은|는|이|가|을|를|의|에|와|과|도|만|로)$/;
/** 용언 어간에 흔한 말미 — 1자 조사 증거만 있을 때는 이런 어간을 신뢰하지 않는다.
 *  과거형 음절(졌·았·었…)까지 포함해야 '부서졌·달라졌' 류가 막힌다(실측). */
const VERB_STEM_FINAL = /(지|하|되|추|르|으|해|워|켜|쳐|려|아|어|여|오|시|기|끼|나|무|누|두|뜨|졌|았|었|였|했|겠|봤|왔|갔|났|섰|줬|쳤|렸|켰|출|들|올|갈|볼|릴|킬)$/;
/** 의존·위치 명사 — 1자 이름꼴 꼬리 자리에 오면 결합구가 '전제 위·머리 쪽'처럼 망가진다. */
const DEPENDENT_TAILS = new Set(['위', '아래', '뒤', '앞', '옆', '안', '밖', '속', '곳', '쪽', '줄', '뿐', '채', '수', '것', '때', '중', '간', '내', '외', '후', '전', '논', '점', '더']);
/** 접미 파편 — '지금쯤·24시간짜리·세번째'. 3자 이상에서만 적용. */
const SUFFIX_FRAGMENT_END = /(쯤|짜리|째)$/;
/** 태그가 될 수 없는 상투 부사·양화사·지시어(조사 형태를 띠어 증거 검사를 통과한다). */
const MANNER_WORDS = new Set(['제멋대로', '저절로', '함부로', '멋대로', '마음대로', '뜻대로', '억지로', '무작정', '대체로', '별로', '따로', '서로',
  '아니라', '아니고', '아닌', '수십', '수백', '수천', '수만', '여러', '대여섯', '한둘', '몇몇', '얼마', '무엇', '누구', '어디', '언제', '왜',
  '어떤', '무슨', '그래', '그런', '이런', '저런', '크게', '작게', '많이', '적게', '빨리', '천천히', '제대로', '고작', '한참']);

/** 어절의 명사 증거 등급. */
function nounEvidence(raw) {
  const t = String(raw || '').replace(/[^가-힣A-Za-z0-9]/g, '');
  if (COPULA_TAIL.test(t) || STRONG_PARTICLE.test(t)) return 'strong';
  if (WEAK_PARTICLE.test(t)) return 'weak';
  return 'bare';
}

/** 증거 등급까지 반영한 최종 채택 여부. */
function acceptStem(raw, stem, evidence) {
  if (!stem || MANNER_WORDS.has(String(raw || '').replace(/[^가-힣A-Za-z0-9]/g, '')) || MANNER_WORDS.has(stem)) return false;
  if (!isNounish(stem, raw)) return false;
  if (stem.length < 2 || stem.length > 12) return false;
  // 어간에 조사가 그대로 남아 있으면(=절단 실패) 실제 명사가 1자라는 뜻 → 태그로 쓰지 않는다.
  // '몸에서'(강한 조사 잔존)·'달이/간을/문을'(2자 어간 + 1자 조사) 류를 여기서 막는다.
  if (STRONG_PARTICLE.test(stem)) return false;
  if (stem.length === 2 && WEAK_PARTICLE.test(stem)) return false;
  if (evidence === 'strong') return true;
  if (evidence === 'weak') return !VERB_STEM_FINAL.test(stem);
  return false;   // bare 는 복합수식 위치에서만 별도로 채택
}

/**
 * 주제 고유 태그 키워드 추출 — 검색어가 될 만한 것만, 검색가치 순으로.
 * 순위: ①두 어절 고유명사구('마거릿 킨') ②연도·수치('1986년') ③단일 명사.
 * 조각(부사·대명사·용언 활용형·1자 파편)은 버린다 — 개수보다 품질이 우선이다.
 * 고유명사구의 구성 어절은 1자여도 예외 허용('킨').
 */
export function extractKeywords(text, limit = 10) {
  // 문장부호를 경계로 어절 그룹을 만든다(문장을 넘는 어절 결합 방지).
  const groups = String(text || '').split(/[^가-힣A-Za-z0-9\s]+/).map(g => g.split(/\s+/).filter(Boolean));
  const namePhrases = [], genericPhrases = [], numbers = [], singles = [], phraseParts = new Set();

  // 1자 이름꼴 꼬리는 **본문에서 2회 이상 나올 때만** 이름으로 인정한다. 인물명은 반복
  // 등장하지만('킨이었고'·'킨이'), '논의는'→'논' 같은 절단 사고는 한 번만 나온다(실측).
  const tailFreq = new Map();
  for (const w of String(text || '').split(/\s+/).filter(Boolean)) {
    if (nounEvidence(w) === 'bare') continue;
    const st = nounStem(w);
    // '킨이었고'는 서술격 조사 절단으로 이미 1자('킨'), '킨이'는 이름꼴 꼬리 절단으로 1자.
    const tl = st.length === 1 ? st : (st.length === 2 ? nameTailStem(w) : '');
    if (tl.length === 1) tailFreq.set(tl, (tailFreq.get(tl) || 0) + 1);
  }

  for (const words of groups) {
    // ① 어절별로 어간·증거·채택 여부를 먼저 확정한다.
    const tok = words.map(raw => {
      const evidence = nounEvidence(raw);
      const stem = nounStem(raw);
      // 1자 고유명사('킨이었고'·'킨은'→'킨')는 조사 절단이 어간을 1자로 만들어 일반 채택에서
      // 탈락한다. 조사·서술격 증거가 있을 때만 이름꼴 꼬리로 따로 보관해 결합구에 쓴다.
      const tail = (evidence !== 'bare' && stem.length === 2) ? nameTailStem(raw) : stem;
      return { raw, stem, tail, evidence, ok: acceptStem(raw, stem, evidence), num: isNumeric(stem) };
    });

    for (let i = 0; i < tok.length; i++) {
      const t = tok[i], next = tok[i + 1];
      // 연도·수치는 증거 없이도 채택(1986년·20세기 — 그대로 검색어가 된다).
      if (t.num) { if (t.stem.length >= 3) numbers.push(t.stem); continue; }

      // ② 맨 어절(증거 없음)은 **복합수식 위치**에서만 채택 — "명예훼손 재판에서"의 '명예훼손',
      //    "마거릿 킨이었고"의 '마거릿'. 뒤 어절이 명사로 확정된 경우에만이라 조각이 못 들어온다.
      // 1자 이름꼴 꼬리('마거릿 킨'의 '킨')는 단독 태그는 못 되지만 결합구의 뒤 어절이 된다.
      const nextNameTail = next && !next.num && next.evidence !== 'bare' && next.tail.length === 1
        && isNounish(next.tail, next.raw) && !DEPENDENT_TAILS.has(next.tail)
        && (tailFreq.get(next.tail) || 0) >= 2 ? next.tail : '';

      const bareModifier = !t.ok && t.evidence === 'bare' && next && (next.ok || nextNameTail) && !next.num
        && t.stem.length >= 2 && t.stem.length <= 8 && !VERB_STEM_FINAL.test(t.stem)
        && isNounish(t.stem, t.raw) && !MANNER_WORDS.has(t.stem);

      if (t.ok || bareModifier) {
        // 두 어절 결합: 조사 없는 앞 어절 + 명사로 확정된 뒤 어절('마거릿 킨'·'명예훼손 재판').
        const tailStem = next ? (nextNameTail || (next.ok && !next.num ? next.stem : '')) : '';
        if (t.evidence === 'bare' && tailStem && !ROLE_NOUNS.has(t.stem) && !ROLE_NOUNS.has(tailStem)
            && t.stem.length >= 2 && t.stem.length <= 6 && tailStem.length <= 6) {
          if (tailStem.length === 1) {
            if (namePhrases.length < 2) { namePhrases.push(`${t.stem} ${tailStem}`); phraseParts.add(t.stem); phraseParts.add(tailStem); }
          } else if (genericPhrases.length < 2) {
            genericPhrases.push(`${t.stem} ${tailStem}`);
          }
        }
        singles.push({ stem: t.stem, at: singles.length });
      }
    }
  }

  // 단일 명사는 **긴 복합어 우선**(명예훼손 > 법정·그림) — 짧은 일반명사가 15개 상한을 먹고
  // 정작 변별력 있는 키워드를 밀어내던 문제(실측)를 이 정렬로 막는다. 동일 길이는 등장순.
  const rankedSingles = singles
    .sort((a, b) => (b.stem.length - a.stem.length) || (a.at - b.at))
    .map(s => s.stem);

  // 이름꼴이 잡혔으면 보통명사 결합은 버린다(품질 우선).
  const phrases = namePhrases.length ? namePhrases : genericPhrases;
  const out = [];
  for (const v of [...phrases, ...numbers, ...rankedSingles]) {
    if (out.length >= limit) break;
    if (out.some(o => o.toLowerCase() === v.toLowerCase())) continue;
    out.push(v);
  }
  return out;
}

/**
 * 주제 해시태그 1~2개 — 브랜드 해시태그만 붙으면 전 영상이 동일해 신규 노출 진입점이 없다.
 * 해시태그는 공백을 못 쓰므로 고유명사구는 붙여쓴다('마거릿 킨'→'#마거릿킨').
 */
export function topicHashtags(chosen, n = 2) {
  const seen = new Set();
  const out = [];
  for (const k of extractKeywords(`${chosen?.subject || ''} ${chosen?.reveal || ''}`, 8)) {
    if (out.length >= n) break;
    const t = k.replace(/\s+/g, '');
    if (t.length < 2 || t.length > 20 || seen.has(t)) continue;
    seen.add(t); out.push(`#${t}`);
  }
  return out;
}

/**
 * 고정 태그 + 주제 키워드 병합 → 8개 이상 15개 이하(중복·30자 초과 제외).
 * ⚠ 8개 보장을 **조각으로 채우지 않는다** — 진짜 키워드가 부족하면 도메인·채널 공통 태그로
 * 채운다(품질 > 개수). 15개 상한은 upload.mjs 절삭과 같은 값.
 */
export function buildTags(baseTags, chosen, minCount = 8, maxCount = 15) {
  const seen = new Set();
  const out = [];
  const push = (t) => {
    const v = collapse(t);
    if (!v || v.length > 30 || out.length >= maxCount) return;
    const key = v.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key); out.push(v);
  };
  for (const t of baseTags || []) push(t);
  for (const k of extractKeywords(`${chosen.subject || ''} ${chosen.reveal || ''}`, 10)) push(k);
  if (chosen.domain) push(chosen.domain);
  for (const p of TAG_PADDING) { if (out.length >= minCount) break; push(p); }
  return out;
}

/**
 * 업로드 메타(제목·설명·태그).
 * - title: 본문 40자 이내 + ' #shorts'
 * - description: 훅(상단 2줄 노출) → 반전 → thundo.kr 역링크 → 구독 CTA → 해시태그
 * - tags: 고정 라벨 + 주제 고유 키워드 8개 이상
 * ⚠ '설마진짜' 라벨은 reveal 앵글 전용(angleLabels) — whatif 에 붙으면 오라벨(기존 계약).
 *   CTA·역링크 문구도 앵글 중립으로 유지해 whatif 에 '설마 진짜'가 새지 않게 한다.
 */
export function buildUploadMeta(chosen, script) {
  const { tags, hashtags } = angleLabels(chosen.angle, chosen.domain);
  const site = siteBaseUrl();
  const description = [
    script?.hook,
    '',
    chosen.reveal,
    '',
    `▶ 더 많은 이야기와 정리글: ${site}`,
    '🔔 매일 3편, 몰랐던 이야기가 올라옵니다 — 구독하고 놓치지 마세요!',
    '',
    // 브랜드 해시태그(고정) + 주제 해시태그(영상별) — 고정만 쓰면 신규 노출 진입점이 없다.
    [hashtags, ...topicHashtags(chosen, 2)].join(' ').trim(),
  ].filter(v => v !== undefined && v !== null).join('\n');
  return {
    title: `${shortenTitleBody(chosen.subject)} #shorts`.slice(0, 100),
    description,
    tags: buildTags(tags, chosen),
  };
}

/**
 * produced 재고의 업로드 메타를 정상 JIT 발행과 같은 계약으로 복원한다.
 * 신규 재고는 제작 시 고정한 upload_meta 를 그대로 쓰고, 구재고는 백로그+script.json 으로
 * 재구성한다. 어느 쪽도 없으면 subject 를 reveal 폴백으로 써서 링크·CTA·풍부한 태그 계약은
 * 지킨다. 재고 경로가 정상 경로보다 빈약해지는 split-brain 방지용 단일 진입점이다.
 */
export function buildProducedUploadMeta(id, entry = {}, backlog = [], script = null) {
  const stored = entry.upload_meta;
  if (stored && typeof stored.title === 'string' && typeof stored.description === 'string' && Array.isArray(stored.tags)) {
    return { title: stored.title, description: stored.description, tags: [...stored.tags] };
  }
  const source = backlog.find(item => item?.id === id) || {};
  const subject = entry.subject || source.subject || id;
  const chosen = {
    ...source,
    ...entry,
    id,
    subject,
    angle: entry.angle || source.angle || 'reveal',
    domain: entry.domain || source.domain || '',
    reveal: entry.reveal || source.reveal || subject,
  };
  const recoveredScript = script || (entry.hook ? { hook: entry.hook } : null);
  return buildUploadMeta(chosen, recoveredScript);
}

/** 구형 produced 재고 메타 복원에 빠진 원본 필드. 업로드 전 경고와 테스트가 공유한다. */
export function producedMetaRecoveryGaps(id, entry = {}, backlog = [], script = null) {
  const stored = entry.upload_meta;
  if (stored && typeof stored.title === 'string' && typeof stored.description === 'string' && Array.isArray(stored.tags)) return [];
  const source = backlog.find(item => item?.id === id) || {};
  const gaps = [];
  if (!entry.reveal && !source.reveal) gaps.push('reveal');
  if (!script?.hook && !entry.hook) gaps.push('hook');
  return gaps;
}

function readProducedScript(slug) {
  if (!slug) return null;
  const file = join(workDir(slug), 'script.json');
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) {
    log.warn(`재고 script.json 복원 실패(${slug}) — 저장 메타/백로그로 계속: ${e.message}`);
    return null;
  }
}

/** 제작 완료 1건을 pending 큐에 적재하고 업로드(staged)까지 처리. produce()/N-루프 공유. */
async function queueAndUpload(chosen, script, prod, cfg) {
  mkdirSync(pendingDir(), { recursive: true });
  const slug = slugify(chosen.id);
  const queued = join(pendingDir(), `${slug}.mp4`);
  copyFileSync(prod.videoFile, queued);
  const meta = buildUploadMeta(chosen, script);
  markStatus(chosen.id, 'produced', {
    video: queued, subject: chosen.subject, slug, angle: chosen.angle, domain: chosen.domain,
    reveal: chosen.reveal, hook: script?.hook, upload_meta: meta,
  });
  const up = await uploadVideo(queued, meta, cfg);
  if (up.ok) {
    markStatus(chosen.id, 'uploaded', { video: queued, subject: chosen.subject, slug, youtube_id: up.youtubeId, youtube_url: up.youtubeUrl, uploaded_at: new Date().toISOString() });
    log.info(`업로드 완료: ${up.youtubeUrl}`);
    // 홈페이지 /videos 탭 자동반영 — 발행분을 사이트 DB(youtube_videos)에 기록(실패해도 발행은 유지).
    const rec = await recordUploadedVideo({ youtubeId: up.youtubeId, youtubeUrl: up.youtubeUrl, subject: chosen.subject, title: chosen.subject, domain: chosen.domain });
    if (!rec.ok) log.warn(`영상 DB 기록 실패(발행은 성공): ${rec.error}`);
    return { subject: chosen.subject, slug, youtube: up.youtubeUrl };
  }
  log.info(`업로드 skip: ${up.reason} → pending 보존`);
  return { subject: chosen.subject, slug, video: queued, upload_skipped: up.reason };
}

/**
 * produced(제작·게이트 통과했으나 미업로드) 재고를 오래된 순으로 count편 업로드하는 폴백.
 * 신규 JIT pick 이 팩트체크 가뭄 등으로 빈손(pick:null)일 때 슬롯이 비지 않도록, 이미 만들어
 * 둔 영상을 내보낸다. upload.enabled=false 면 uploadVideo 가 skip → no-op(회귀 없음).
 * 라벨은 항목에 저장된 angle(reveal|whatif)을 존중해 angleLabels 로 안전 발행한다.
 * 현재 whatif_ratio=0이면 과거 whatif 재고도 제외해 성과 대응 하드 중지를 우회하지 않는다.
 */
export async function uploadProducedFallback(cfg, count = 1) {
  if (count <= 0) return [];
  const index = loadIndex();
  const candidates = Object.entries(index)
    .filter(([, v]) => isUploadableInventory(v, cfg))
    .sort((a, b) => new Date(a[1].at || 0) - new Date(b[1].at || 0)); // 오래된 순
  const backlog = loadBacklog();
  const out = [];
  for (const [id, v] of candidates) {
    if (out.length >= count) break;
    const subject = v.subject || id;
    const recoveredScript = readProducedScript(v.slug);
    const recoveryGaps = producedMetaRecoveryGaps(id, v, backlog, recoveredScript);
    if (recoveryGaps.length) {
      // 슬롯 연속성을 위해 안전 메타는 생성하되, 손상된 구형 재고를 정상 복원처럼 숨기지 않는다.
      log.warn(`구형 재고 메타 원본 누락(${id}: ${recoveryGaps.join(',')}) — 안전 폴백으로 계속`);
    }
    const meta = buildProducedUploadMeta(id, v, backlog, recoveredScript);
    let up;
    try {
      up = await uploadVideo(v.video, meta, cfg);
    } catch (e) {
      // 개별 영상의 일시 오류(네트워크·토큰 등)는 슬롯을 죽이지 말고 다음 재고로.
      log.warn(`재고 폴백 업로드 예외 → 다음 후보: ${subject} (${e.message})`);
      continue;
    }
    if (!up.ok) {
      log.info(`재고 폴백 업로드 skip: ${up.reason}`);
      // skipped=자격·설정 미비(모든 후보 공통) → 중단. 그 외(개별 영상 업로드 실패) → 다음 후보.
      if (up.skipped) break;
      continue;
    }
    markStatus(id, 'uploaded', { video: v.video, subject, slug: v.slug, youtube_id: up.youtubeId, youtube_url: up.youtubeUrl, uploaded_at: new Date().toISOString(), from_inventory: true });
    log.info(`재고 폴백 업로드: ${subject} → ${up.youtubeUrl}`);
    const rec = await recordUploadedVideo({ youtubeId: up.youtubeId, youtubeUrl: up.youtubeUrl, subject, title: subject, domain: v.domain });
    if (!rec.ok) log.warn(`영상 DB 기록 실패(발행은 성공): ${rec.error}`);
    out.push({ subject, slug: v.slug, youtube: up.youtubeUrl, from_inventory: true });
  }
  return out;
}

export async function runDaily({ cfg } = {}) {
  cfg = cfg || loadConfig();
  if (!cfg.enabled) return { ok: true, skipped: 'disabled' };
  ensureDirs();

  // ① 백로그 보충(버퍼 미달 시) — 임계는 refillThreshold(며칠치 소비분) 기준.
  const pendingCount = pendingBacklog().length;
  if (needsRefill(pendingCount, cfg)) {
    log.info(`백로그 버퍼 미달(잔여 ${pendingCount} < 임계 ${refillThreshold(cfg)}) → 보충`);
    try { await refillBacklog({}); } catch (e) { log.warn(`보충 실패(계속): ${e.message}`); }
  }

  const bestN = cfg.pick?.best_n ?? 1;

  // ---- best_n<=1: 기존 단일 경로 (회귀 금지 — 원본과 완전 동일한 로직) ----
  if (bestN <= 1) {
    // ②③ 선정 + 사실확인 (ok 아니면 보류하고 다음, 최대 3회)
    let chosen = null, fc = null, pickReason = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const p = await pick();
      if (!p.pick) { pickReason = p.reason; break; }
      fc = await factCheck(p.pick, { cfg });
      const dec = resolveFactcheck(p.pick, fc);
      if (dec.action === 'publish') {
        chosen = dec.item; chosen._score = p.score;
        if (dec.corrected) {
          log.warn(`팩트체크 정정 반영 → 제목·대본 소스 교체: "${p.pick.subject}" → "${chosen.subject}"`);
        }
        break;
      }
      log.warn(`${dec.log} → 보류: ${p.pick.subject} (${fc.note})`);
      markStatus(p.pick.id, 'held', { reason: dec.reason, note: dec.note, factcheck_fails: (loadIndex()[p.pick.id]?.factcheck_fails || 0) + 1 });
    }
    if (!chosen) {
      // 신규 pick 빈손 → produced 재고 폴백(슬롯이 비지 않게). 재고도 없으면 원래대로 pick:null.
      const fb = await uploadProducedFallback(cfg, 1);
      if (fb.length) return { ok: true, ...fb[0], fallback: 'produced_inventory' };
      return { ok: true, pick: null, reason: pickReason || '사실확인 통과 후보 없음(3회)' };
    }
    log.info(`선정+검증 OK: ${chosen.subject} (점수 ${chosen._score?.toFixed?.(3)})`);

    // ④ JIT 풀 제작
    let { script } = await generateScript(chosen, { cfg });

    // ④-1 다양성 가드 — 최근 업로드분과 hook/cta 가 너무 닮으면 대본만 재생성(최대 2회).
    // 그래도 실패하면 경고만 남기고 그대로 진행(발행 슬롯 공백 방지가 우선 — 차단권 없음).
    const maxRegenerate = 2;
    let diversity = checkDiversity(script, { cfg });
    for (let i = 0; i < maxRegenerate && !diversity.ok; i++) {
      log.warn(`다양성 가드 fail(유사도 ${diversity.maxSim} vs "${diversity.against?.subject}") → 대본 재생성 ${i + 1}/${maxRegenerate}`);
      ({ script } = await generateScript(chosen, { cfg }));
      diversity = checkDiversity(script, { cfg });
    }
    if (!diversity.ok) {
      log.warn(`다양성 가드 재생성 후에도 유사(유사도 ${diversity.maxSim}) → 그대로 진행`);
    }

    const prod = await produceFromScript(script, { cfg });
    if (!prod.ok) {
      markStatus(chosen.id, 'held', { reason: `produce:${prod.stage}`, note: prod.reason });
      return { ok: false, stage: prod.stage, reason: prod.reason, subject: chosen.subject, steps: prod.steps };
    }

    // ⑤ pending 큐 + 상태기록
    mkdirSync(pendingDir(), { recursive: true });
    const slug = slugify(chosen.id);
    const queued = join(pendingDir(), `${slug}.mp4`);
    copyFileSync(prod.videoFile, queued);
    // ⑥ 업로드 (staged — config.upload.enabled 일 때만). angle 별 메타(whatif≠설마진짜).
    const meta = buildUploadMeta(chosen, script);
    markStatus(chosen.id, 'produced', {
      video: queued, subject: chosen.subject, slug, angle: chosen.angle, domain: chosen.domain,
      reveal: chosen.reveal, hook: script?.hook, upload_meta: meta,
    });
    const up = await uploadVideo(queued, meta, cfg);
    if (up.ok) {
      markStatus(chosen.id, 'uploaded', { video: queued, subject: chosen.subject, slug, youtube_id: up.youtubeId, youtube_url: up.youtubeUrl, uploaded_at: new Date().toISOString() });
      log.info(`업로드 완료: ${up.youtubeUrl}`);
      // 홈페이지 /videos 탭 자동반영 — 발행분을 사이트 DB(youtube_videos)에 기록(실패해도 발행은 유지).
      const rec = await recordUploadedVideo({ youtubeId: up.youtubeId, youtubeUrl: up.youtubeUrl, subject: chosen.subject, title: chosen.subject, domain: chosen.domain });
      if (!rec.ok) log.warn(`영상 DB 기록 실패(발행은 성공): ${rec.error}`);
      return { ok: true, subject: chosen.subject, slug, youtube: up.youtubeUrl, factcheck: fc, steps: prod.steps };
    }
    log.info(`업로드 skip: ${up.reason} → pending 보존`);
    return { ok: true, subject: chosen.subject, slug, video: queued, upload_skipped: up.reason, factcheck: fc, steps: prod.steps };
  }

  // ---- best_n>=2: 병행 제작(AC-8, A/B용) ----
  // pickTopN 은 채점(claude 배치 1콜)을 한 번만 수행 — 넉넉히 N+2건을 받아 순서대로 시도.
  const pool = await pickTopN(bestN + 2);
  if (!pool.picks || pool.picks.length === 0) return { ok: true, pick: null, reason: pool.reason };

  const produced = [];
  const seenIds = new Set();
  for (const cand of pool.picks) {
    if (produced.length >= bestN) break;
    const item = cand.item;
    if (seenIds.has(item.id)) continue;   // 동일 런 내 같은 id 중복 제작 방지
    seenIds.add(item.id);

    // 후보 1건의 예외(대본 LLM JSON 파싱 실패·팩트체크 오류 등)는 배치를 죽이지 않고
    // 이 후보만 보류(held)하고 다음 후보로 넘어간다 — best-N 은 성공 N편까지 계속 시도.
    try {
      const fc = await factCheck(item, { cfg });
      const dec = resolveFactcheck(item, fc);
      if (dec.action !== 'publish') {
        log.warn(`${dec.log} → 보류: ${item.subject} (${fc.note})`);
        markStatus(item.id, 'held', { reason: dec.reason, note: dec.note, factcheck_fails: (loadIndex()[item.id]?.factcheck_fails || 0) + 1 });
        continue;
      }
      const chosen = dec.item;
      if (dec.corrected) log.warn(`팩트체크 정정 반영 → 제목·대본 소스 교체: "${item.subject}" → "${chosen.subject}"`);
      chosen._score = cand.score;
      log.info(`선정+검증 OK: ${chosen.subject} (점수 ${chosen._score?.toFixed?.(3)})`);

      const { script } = await generateScript(chosen, { cfg });
      const prod = await produceFromScript(script, { cfg });
      if (!prod.ok) {
        markStatus(chosen.id, 'held', { reason: `produce:${prod.stage}`, note: prod.reason });
        log.warn(`제작 실패 → 다음 후보: ${chosen.subject} (${prod.stage}: ${prod.reason})`);
        continue;
      }

      const queuedResult = await queueAndUpload(chosen, script, prod, cfg);
      produced.push({ ...queuedResult, factcheck: fc, steps: prod.steps });
    } catch (e) {
      markStatus(item.id, 'held', { reason: 'exception', note: e.message });
      log.warn(`후보 처리 예외 → 다음 후보: ${item.subject} (${e.message})`);
      continue;
    }
  }

  // 신규 제작이 목표(bestN)에 못 미치면 produced 재고로 부족분 폴백(슬롯 공백 방지).
  if (produced.length < bestN) {
    const fb = await uploadProducedFallback(cfg, bestN - produced.length);
    for (const f of fb) produced.push({ ...f, fallback: 'produced_inventory' });
  }
  if (produced.length === 0) {
    return { ok: false, pick: null, reason: '병행 제작 후보 전원 탈락(factcheck/제작 실패)', count: 0 };
  }
  return { ok: true, produced, count: produced.length };
}

async function main() {
  try {
    const r = await runDaily();
    process.stdout.write(JSON.stringify(r) + '\n');
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    log.error(`파이프라인 오류: ${e.message}`);
    process.stdout.write(JSON.stringify({ ok: false, reason: e.message }) + '\n');
    process.exit(2);
  }
}

if (isMainModule(import.meta.url)) main();
