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
import { stripJosa } from '../kernel/korean.mjs';
// 조사 제거는 채널 지식이 아니라 한국어 처리다 → 정본은 kernel/korean.mjs.
// 기존 소비자(cardnews-pick 테스트 등)를 위해 여기서 재export 한다.
export { stripJosa };
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
 * ── 소재 중복 2차 방어: 내용어 기반 유사도 (2026-08-21 신설) ────────────────
 *
 * 왜 문자 bigram 만으로 부족한가:
 *   bigram 은 **표현이 닮은 것**을 잡지 문장이 **같은 사건을 말하는 것**을 못 잡는다.
 *   실제로 같은 이야기가 다른 문장으로 재발행된 3쌍이 전부 통과했다(실측 2026-08-21):
 *     · "대포알에 오른손을 잃고 철제 의수로 40년…기사"  ↔ "총알에 팔을 잃고 스프링 손을…기사"  j=0.212
 *     · "지하철 안내방송이 사라지자 남편을 잃은 여성"      ↔ "지하철 안내방송을 들으려고…할머니"     j=0.182
 *     · "죽은 연어의 뇌가 사람의 감정을 읽었다는 fMRI 실험" ↔ "죽은 연어의 뇌가 사람 사진에 '반응'했다" j=0.292
 *   임계(0.45)를 이 값들까지 내리면 서로 다른 주제까지 쓸려 나간다 — 임계 조정으로는 못 푼다.
 *
 * 그래서 무엇을 보는가:
 *   조사·군더더기를 털어낸 **내용어**를 비교하되, 흔한 낱말은 거의 무시하고 **드문 낱말이
 *   겹칠 때만** 무겁게 센다(코퍼스 역빈도 가중). "연어·뇌"가 두 번 겹치면 같은 이야기지만
 *   "사람·하나"가 겹치는 건 아무 뜻도 아니기 때문이다.
 *
 * ⚠ 이 방어선이 필요한 이유가 하나 더 있다: 팩트체크 정정이 **게이트 통과 뒤에** subject 를
 *   고쳐 쓴다. 위 1번 쌍은 백로그 단계에선 "쇠손/30년" 과 "스프링 손/30년" 으로 서로 달랐는데
 *   정정이 둘 다 같은 사실(철제 의수·40년)로 수렴시켰다. 발행 문구만 보면 j=0.609 로 명백한
 *   중복인데 게이트가 본 값은 0.212 였다. 즉 게이트는 **정정 전** 문구로 판단할 수밖에 없으므로,
 *   표현이 아니라 소재를 보는 측정이 있어야 한다.
 */

/** 내용어 판별에서 제외할 기능어·상투어. 이게 겹치는 건 소재가 같다는 신호가 아니다. */
const CONTENT_STOPWORDS = new Set([
  '그', '이', '저', '것', '수', '때', '더', '안', '못', '매우', '아주', '정말', '사실', '진짜',
  '하나', '대해', '위해', '있는', '없는', '되는', '하는', '한', '두', '세', '네', '모든',
  '어떤', '무슨', '왜', '어떻게', '만약', '전부', '가장', '제일', '먼저', '내일', '오늘',
  '사람', '세계', '우리', '당신',
]);

/**
 * 주제에서 내용어만 뽑는다. normalizeSubject 와 달리 **어절을 붙이지 않고** 낱말로 남긴다
 * (낱말 단위로 겹침을 세야 "같은 사건"이 드러난다).
 */
export function contentTokens(s) {
  return String(s || '')
    .replace(/[()[\]{}<>《》「」『』"'\u201c\u201d\u2018\u2019«»]/g, ' ')
    .replace(/[.,!?~·:;\-—–_/\\|+*=…%$#@&^]/g, ' ')
    .toLowerCase()
    .split(/\s+/).filter(Boolean)
    .map(stripJosa)
    .filter(w => w.length >= 2 && !CONTENT_STOPWORDS.has(w));
}

/**
 * 기존 주제 목록에서 낱말별 등장 문서수(df)를 센다. 흔한 낱말을 깎기 위한 재료.
 * @returns {{df: Map<string, number>, n: number}}
 */
export function tokenDocFreq(subjects = []) {
  const df = new Map();
  let n = 0;
  for (const s of subjects) {
    if (!s) continue;
    n++;
    for (const t of new Set(contentTokens(s))) df.set(t, (df.get(t) || 0) + 1);
  }
  return { df, n };
}

/** 희소도 추정에 필요한 최소 코퍼스 규모. 이보다 적으면 이 값으로 간주해 가중치 역전을 막는다. */
const MIN_CORPUS_FOR_IDF = 30;

/**
 * 소재가 같다고 인정하려면 **드문 낱말이 최소 이만큼** 겹쳐야 한다.
 *
 * 가중 유사도만 쓰면 낱말 하나가 우연히 겹친 짧은 문장이 임계를 넘을 수 있다. 실제로
 * "호랑이는 주황색이 아니다" ↔ "유리는 액체가 아니다" 가 '아니다' 하나로 0.155 를 받아
 * 오차단됐다. 처음엔 "코퍼스가 작을 때만 생기는 문제"로 보고 코퍼스 30건 미만에서 관문을 껐지만,
 * 그건 증상 가림이었다 — 그 구간이 통째로 사각지대가 된다(코덱스 리뷰 지적).
 *
 * 2개 조건으로 바꾸면 근본이 막힌다 — 그리고 재현 결과가 나빠지지 않는다:
 *   공유 1개(기존) → 중복 11건 차단·오차단 2   공유 2개 → **동일**   공유 3개 → 1건 놓침
 * 덕분에 코퍼스 크기로 관문을 껐다 켰다 할 필요가 없어졌다(게이트 0·5·10·30 결과 모두 동일).
 */
const MIN_SHARED_CONTENT_TOKENS = 2;

/** 두 주제가 공유하는 내용어 개수. */
export function sharedContentTokens(a, b) {
  const A = new Set(contentTokens(a));
  const B = new Set(contentTokens(b));
  let n = 0;
  for (const t of A) if (B.has(t)) n++;
  return n;
}

/**
 * 내용어 가중 Jaccard — 겹친 낱말의 희소도 합 ÷ 전체 낱말의 희소도 합.
 * 희소도는 log((n+1)/(df+0.5)) 로, 코퍼스에 흔할수록 0 에 가까워진다.
 */
export function topicSimilarity(a, b, corpus = { df: new Map(), n: 0 }) {
  const A = new Set(contentTokens(a));
  const B = new Set(contentTokens(b));
  if (!A.size || !B.size) return 0;
  // ⚠ 코퍼스가 작으면 희소도 추정이 뒤집힌다. 예를 들어 기존 주제가 1건뿐이면 그 주제의 모든
  //   낱말이 df=1/n=1, 즉 "100% 문서에 등장 = 흔한 말"로 계산돼 **겹친 낱말일수록 가중치가
  //   낮아진다.** 정보이론적으로는 맞는 계산이지만(1건으로는 희소도를 알 수 없다) 판정에는
  //   해롭다. 채널 초기·테스트처럼 표본이 적을 때를 대비해 분모 모수에 하한을 둔다.
  const n = Math.max(corpus.n, MIN_CORPUS_FOR_IDF);
  const weight = t => Math.log((n + 1) / ((corpus.df.get(t) || 0) + 0.5));
  let inter = 0, union = 0;
  for (const t of new Set([...A, ...B])) {
    const w = weight(t);
    union += w;
    if (A.has(t) && B.has(t)) inter += w;
  }
  return union > 0 ? inter / union : 0;
}

/**
 * 후보 주제가 기존 주제들과 사실상 같은 소재인지 판정.
 *
 * 두 관문 중 하나만 걸려도 중복이다:
 *   ① 표현 닮음 — 포함관계 또는 문자 bigram Jaccard >= bigram_jaccard (기존)
 *   ② 소재 같음 — 내용어 가중 유사도 >= topic_jaccard (신설)
 *
 * topic_jaccard 기본 0.14 는 추정이 아니라 **이력 재현으로 측정한 값**이다. 발행 115편을
 * 시간순으로 재생하되, 운영과 같은 조건을 지켰다 — 후보는 **백로그 문구**(게이트가 실제로 보는
 * 것), 코퍼스는 **발행 문구**(index 에 쌓이는 것)를 썼다. 이 구분이 중요하다: 115편 중 33편
 * (29%)이 게이트를 지난 뒤 팩트체크·대본 단계에서 문구가 바뀌었다. 발행 문구끼리 비교하면
 * 실제보다 후하게 나온다(같은 사건이 정정으로 같은 표현에 수렴하므로).
 *
 * 측정 결과:
 *   0.14 → 실제 중복 11건 전량 차단, 놓침 0, 오차단 2
 *   0.15 → 놓침 1 (지하철 안내방송 쌍이 0.145 로 아슬하게 빠져나간다)
 *   0.13 → 오차단 3, 0.12 → 오차단 4 (놓침은 계속 0)
 * 즉 안전한 띠는 0.133~0.145 로 좁다. 가장 빡빡한 실제 중복이 0.145, 가장 가까운 오차단이
 * 0.181 이라 완전 분리는 불가능하다. 그 비대칭을 의도적으로 재현(놓치지 않는) 쪽에 뒀다 —
 * 후보를 잘못 막으면 다음 후보가 슬롯을 채우지만, 중복을 내보내면 구독자가 그걸 본다.
 *
 * 과적합 검증(시간 홀드아웃): 앞 60편으로 임계를 고르고 **뒤 55편에만** 적용했을 때
 *   0.14 → 차단 10·오차단 0·놓침 0 / 0.15 → 놓침 1. 표본 밖에서도 같은 값이 이긴다.
 *
 * ⚠ 한계: 희소도를 기존 주제에서 추정하므로 코퍼스가 클수록 강해진다. 채널 초기에는 이 관문이
 *   상대적으로 약하다(그 시기엔 재탕 자체가 드물다).
 */
export function isNearDuplicate(subject, existing, opts = {}) {
  const threshold = opts.bigram_jaccard ?? 0.45;
  const topicThreshold = opts.topic_jaccard ?? 0.14;
  const useSubstring = opts.substring !== false;
  const minShared = Number.isFinite(opts.min_shared_tokens) ? opts.min_shared_tokens : MIN_SHARED_CONTENT_TOKENS;
  const useTopic = opts.topic !== false;
  // df 는 후보마다 달라지지 않으므로 루프 밖에서 한 번만 만든다.
  const corpus = useTopic ? tokenDocFreq(existing) : null;
  let worst = { dup: false, jaccard: 0, topic: 0, against: null };
  for (const other of existing) {
    if (!other) continue;
    const { jaccard, contained } = subjectSimilarity(subject, other, opts);
    const topic = useTopic ? topicSimilarity(subject, other, corpus) : 0;
    // 소재 관문은 두 조건을 **둘 다** 만족해야 한다 — 가중치가 높아도 겹친 낱말이 하나뿐이면
    // 우연일 수 있다(MIN_SHARED_CONTENT_TOKENS 주석 참고).
    const topicDup = useTopic
      && topic >= topicThreshold
      && sharedContentTokens(subject, other) >= minShared;
    const dup = (useSubstring && contained) || jaccard >= threshold || topicDup;
    if (dup) {
      return {
        dup: true,
        jaccard: Number(jaccard.toFixed(3)),
        topic: Number(topic.toFixed(3)),
        contained,
        // 어느 관문이 잡았는지 로그·테스트에서 구분할 수 있어야 한다.
        by: (useSubstring && contained) || jaccard >= threshold ? 'wording' : 'topic',
        against: other,
      };
    }
    if (jaccard > worst.jaccard || topic > worst.topic) {
      worst = {
        dup: false,
        jaccard: Number(Math.max(jaccard, worst.jaccard).toFixed(3)),
        topic: Number(Math.max(topic, worst.topic).toFixed(3)),
        against: other,
      };
    }
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
  const target = Number.isFinite(cfg.pick?.daily_target) ? cfg.pick.daily_target : 2;
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
        blocked.push({ id: it.id, subject: it.subject, reason: 'similar_subject', against: d.against, jaccard: d.jaccard, topic: d.topic, by: d.by });
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
export function takeWithWhatifCap(sorted = [], n = 1, allowance = 0, { relaxable = [], relaxIfShort = false, similarity = null } = {}) {
  const out = [];
  let usedWhatif = 0;
  /**
   * 같은 배치 안에서도 서로 재탕이면 안 된다.
   *
   * filterCandidates 는 후보를 **기발행 이력**과만 대조한다. best_n>=2(결손 보충 슬롯 등)로
   * 한 번에 여러 편을 뽑을 때는 후보끼리 비교되지 않아, 비슷한 두 후보가 같은 날 나란히
   * 나갈 수 있다 — 이력 대조를 아무리 강화해도 이 경로로 새어 나간다.
   */
  const acceptedSubjects = [];
  const isBatchDuplicate = (item) => {
    if (!similarity || similarity.enabled === false || !item?.subject || !acceptedSubjects.length) return false;
    return isNearDuplicate(item.subject, acceptedSubjects, similarity).dup;
  };
  const accept = (entry) => { out.push(entry); if (entry.item?.subject) acceptedSubjects.push(entry.item.subject); };
  for (const s of sorted) {
    if (out.length >= n) break;
    if (isBatchDuplicate(s.item)) continue;     // 이미 담은 후보와 같은 소재면 건너뛴다
    if (s.item?.angle === 'whatif') {
      if (usedWhatif >= allowance) continue;
      usedWhatif++;
    }
    accept(s);
  }
  if (!relaxIfShort) return out;
  const picked = new Set(out.map(s => s.item?.id));
  for (const s of relaxable) {
    if (out.length >= n) break;                 // 부족분만 — 최소 완화
    if (picked.has(s.item?.id)) continue;
    if (isBatchDuplicate(s.item)) continue;     // 완화 경로로도 재탕은 못 나간다
    accept({ ...s, relaxed: true });
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
      // 어느 관문이 잡았는지 남긴다 — 표현(wording) 과 소재(topic) 는 대응이 다르다.
      const how = b.by === 'topic' ? `소재 t=${b.topic}` : `표현 j=${b.jaccard}`;
      log.info(`후보 제외(유사주제 중복 ${how}): ${b.subject} ↔ "${b.against}"`);
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
  const taken = takeWithWhatifCap(sorted, n, allowance, { relaxable, relaxIfShort, similarity: cfg.pick?.similarity });
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
