/**
 * shorts/tts/normalize.mjs — 합성 직전 결정론적 TTS 발음 정규화 세이프넷
 *
 * 대본 narration 에 남는 영어 약어·기호·숫자단위가 Chirp3-HD 에서 뭉개지는 것을
 * (예: "FDA"→읽다 마는 소리, "%"·"km" 미독) **말하는 텍스트에만** 결정론적으로
 * 한글 발음으로 치환한다. 화면 자막(caption)·저장된 script.json 원문은 건드리지 않는다 —
 * synth 로 넘어가는 문자열만 통과시키는 순수 함수다.
 *
 * ⚠ 범위: 대문자 약어(2~5자)·기호·숫자에 붙은 단위에만 집중.
 *   한국어 텍스트 중간의 임의 라틴 소문자 단어(예: teflon)는 대본이 대부분 음차하므로
 *   건드리지 않는다(오탐이 오히려 위험). 실패 불가·예외 없음.
 */

/** 알려진 영어 약어 → 한글 발음 사전(letter-by-letter 폴백보다 우선). */
const ABBR_DICT = {
  FDA: '에프디에이', NASA: '나사', CEO: '씨이오', DNA: '디엔에이',
  AI: '에이아이', UN: '유엔', GDP: '지디피', GPS: '지피에스',
  USB: '유에스비', API: '에이피아이',
};

/** 알파벳 1자 → 한글 발음(미등록 대문자 약어 letter-by-letter 폴백). */
const LETTER_KO = {
  A: '에이', B: '비', C: '씨', D: '디', E: '이', F: '에프', G: '지',
  H: '에이치', I: '아이', J: '제이', K: '케이', L: '엘', M: '엠', N: '엔',
  O: '오', P: '피', Q: '큐', R: '알', S: '에스', T: '티', U: '유',
  V: '브이', W: '더블유', X: '엑스', Y: '와이', Z: '제트',
};

/**
 * 대문자 약어 1건을 한글 발음으로 — 사전 우선, 미등록은 letter-by-letter.
 * @param {string} abbr 대문자 2~5자
 * @returns {string} 한글 발음
 */
function abbrToKo(abbr) {
  if (ABBR_DICT[abbr]) return ABBR_DICT[abbr];
  return [...abbr].map((c) => LETTER_KO[c] || c).join('');
}

/**
 * normalizeForTTS — 합성 직전 발음 정규화(순수 함수, 실패 불가 경로).
 *
 * 순서: (1)숫자에 붙은 단위 → (2)기호 → (3)대문자 약어. 각 단계 결정론적 치환.
 * 단위는 숫자에 붙은 경우만 잡아 오탐 방지('m' 단독·한글 중간 라틴 1자는 미변형).
 *
 * @param {string} text 합성 대상 문자열(prosody 정규화 후)
 * @returns {string} 발음 정규화 텍스트(빈/비문자열은 원문 반환)
 */
export function normalizeForTTS(text) {
  if (typeof text !== 'string' || !text) return text;
  let t = text;

  // (1) 숫자에 딱 붙은 단위 — 긴 단위부터(km/cm 가 m 보다 먼저). \b 로 뒤 경계 고정.
  t = t
    .replace(/(\d)\s?m\/s\b/g, '$1미터퍼초')
    .replace(/(\d)\s?km\/h\b/g, '$1킬로미터퍼아워')
    .replace(/(\d)\s?km\b/g, '$1킬로미터')
    .replace(/(\d)\s?kg\b/g, '$1킬로그램')
    .replace(/(\d)\s?cm\b/g, '$1센티미터')
    .replace(/(\d)\s?mm\b/g, '$1밀리미터')
    .replace(/(\d)\s?m\b/g, '$1미터');

  // (2) 기호/단위 — % · 온도 · 달러.
  t = t
    .replace(/%/g, '퍼센트')
    .replace(/(?:℃|°C|°c)/g, '도')
    .replace(/\$\s?(\d[\d,.]*)/g, '$1달러') // "$50" → "50달러"
    .replace(/\$/g, '달러');

  // (3) 대문자 약어(2~5자, 라틴 인접 아님) → 사전/letter-by-letter.
  t = t.replace(/(?<![A-Za-z])[A-Z]{2,5}(?![A-Za-z])/g, (m) => abbrToKo(m));

  return t;
}
