/**
 * kernel/korean.mjs — 한국어 형태소·키워드 처리 (순수함수)
 *
 * 왜 옮겼는가(F-03): 이 자산은 `shorts-curiosity/run-curiosity.mjs` 안에 있었다.
 * 그 파일은 825줄인데 실제 오케스트레이션(`runDaily`)은 173줄이고, 나머지 약 610줄이
 * 이것이었다 — 어미·조사 정규식 12종, 역할명사·부사 사전, 어간 추출, 키워드 뽑기.
 *
 * **이 저장소에서 가장 재사용 가치가 높고 가장 테스트하기 쉬운 코드가, 하필 가장
 * 테스트하기 어려운 곳(cron 진입점)에 갇혀 있었다.** 카드뉴스 캡션·블로그 태그·
 * 네이버 키워드가 전부 같은 처리를 필요로 하지만 가져다 쓸 방법이 없었다.
 *
 * 로직은 한 줄도 바꾸지 않았다 — 위치만 옮겼다. 판정이 달라지면 쇼츠 제목·태그가
 * 달라지므로, 이동 전후를 실제 백로그·발행 이력으로 대조해 동일함을 확인했다.
 * (유일한 변경: 모듈 내부 상수 `TAG_STOPWORDS` → `STEM_STOPWORDS`. 이름이 '태그용'
 *  이라고 말하지만 실제로는 어간 판별에 쓰인다 — F-09 와 같은 종류의 오도였다.)
 *
 * 커널 규약: fs·child_process·Date 를 import 하지 않는다. 채널 지식도 갖지 않는다
 * (해시태그 보충어 `TAG_PADDING` 같은 채널 고유 값은 호출부에 남겼다).
 */

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
 * 태그 키워드에서 걸러낼 기능어·상투어.
 * 실측(2026-07-30 12시 슬롯): "법정에서 그림을 직접 그려 자기 작품임을 증명한 화가" 를 어절로
 * 쪼개 `직접·그려·자기·작품임·증명한·세계적` 이 그대로 태그가 됐다 — 아무도 검색하지 않는
 * 조각이 15개 상한을 잡아먹어 정작 필요한 고유명사(마거릿 킨·명예훼손)를 밀어냈다.
 */
const STEM_STOPWORDS = new Set(['만약', '정말', '과연', '진짜', '그리고', '하지만', '그런데', '우리', '있는', '없는', '무슨', '어디서', '어떻게', '가장',
  '먼저', '전부', '내일', '아예', '모두', '사람', '사실', '이유', '그것', '때문', '한다면', '했다면', '된다면', '이라면', '라면', '일까', '까지', '동안',
  '위해', '대한', '지금', '오늘', '실제', '경우', '수도', '거의', '바로', '가지', '것도', '다면', 'shorts',
  // 부사·대명사·수식어(검색어 가치 0)
  '직접', '자기', '자신', '매우', '아주', '무척', '너무', '조금', '거의', '겨우', '결국', '오히려', '심지어', '함께', '서로', '스스로', '각자',
  '당시', '이후', '이전', '처음', '마지막', '대부분', '일부', '하나', '이것', '저것', '여기', '거기', '어제', '요즘', '항상', '이미', '아직',
  '그때', '나중', '다음', '전체', '온갖', '무려', '실은', '역시', '물론', '특히', '반면', '따라서', '그래서', '때문에',
  '그대로', '그대', '마찬가지', '여전히', '다시', '이제', '그냥', '아마', '어쩌면', '심하', '가까이', '무조건',
  // 추상 명사(어떤 주제에나 붙어 변별력이 없다)
  '정도', '부분', '상황', '방법', '문제', '이야기', '내용', '결과', '사이', '모습', '느낌', '생각', '기분', '차이', '종류', '수준']);

/** 제목 본문 상한(자). Shorts 피드는 이보다 길면 절삭돼 CTR 을 깎는다. */
const TITLE_BODY_MAX = 40;
/** 의미는 거의 없고 길이만 먹는 군더더기(축약 1순위). */
const TITLE_FILLERS = ['내일', '전부', '아예', '딱', '끝내', '정말', '과연', '실제로', '도대체', '굳이', '진짜로', '무려'];

export const collapse = (s) => String(s || '').replace(/\s+/g, ' ').trim();

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

/** 접미 파편 — '지금쯤·24시간짜리·세번째'. 3자 이상에서만 적용. */
const SUFFIX_FRAGMENT_END = /(쯤|짜리|째)$/;

/** 어간이 태그로 쓸 만한 명사인가(길이는 호출자가 판단 — 고유명사 1자 예외 때문). */
function isNounish(stem, raw) {
  if (!stem || stem.length > 20) return false;
  if (STEM_STOPWORDS.has(stem.toLowerCase())) return false;
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
