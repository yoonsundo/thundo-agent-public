/**
 * cardnews/caption.mjs — 우선순위 절삭 캡션 빌더 (계획 §3.12, AC-11)
 *
 * 순수 함수. I/O 없음.
 *
 * 멱등 마커는 항상 캡션 **최말미**에 고정된다 — 발행 결과가 불확실할 때(publish_unknown)
 * 이 문자열로 "이미 올라간 게시물"을 되찾는 유일한 키다. 글자수 절삭에 마커가 휘말리면
 * 실제로는 발행된 글이 "미발행"으로 보이고, Instagram Content Publishing API 에 삭제
 * 엔드포인트가 없다(F1)는 사실과 겹쳐 재시도가 곧바로 중복 게시로 이어진다. 그래서
 * 마커는 항상 `lib.mjs` 의 `idemMarker(postId)` 를 그대로 호출해 얻고(문자열을 직접
 * 조립하지 않는다 — §3.2 참고), 모든 절삭 단계에서 절대 제거 대상이 되지 않는다.
 *
 * 절삭은 나이브한 글자수 자르기가 아니라 **우선순위**를 따른다: body 를 문장 경계로
 * 먼저 줄이고, 그래도 넘치면 hook 을 어절 경계로 줄이고, 그래도 넘치면 해시태그를
 * 뒤에서부터 하나씩 버린다. cta 와 마커는 끝까지 보존한다.
 *
 * 실제 재현 방식: 각 단계에서 "이 정도까지 줄이면 될 것"이라는 예산(budget)을 구해
 * 후보를 만든 뒤, 실제로 캡션 전체를 조립(compose)해 길이를 다시 잰다. 손으로 유도한
 * 구분자 산수에 기대지 않고 항상 실측값으로 다음 단계 진입 여부를 판단하므로, 섹션이
 * 비어 사라지는 경계(구분자 개수가 바뀌는 지점)에서도 어긋나지 않는다.
 */
import { idemMarker } from './lib.mjs';

const SEP = '\n\n';
const SENTENCE_BOUNDARY = /(?<=[.!?…])\s+/;
const WORD_BOUNDARY = /\s+/;

/**
 * @param {{hook?:string, body?:string, cta?:string, hashtags?:string[], postId:string}} input
 * @param {object} [cfg] `config/cardnews.json` 의 `caption` 섹션을 담은 객체(또는 전체 cfg)
 * @returns {{caption:string, chars:number, hashtagCount:number, idemMarker:string,
 *            truncated:{body:boolean, hook:boolean, hashtags:boolean}}}
 */
export function buildCaption({ hook, body, cta, hashtags, postId } = {}, cfg = {}) {
  const capCfg = cfg?.caption || cfg || {};
  const maxChars = Number.isFinite(capCfg.max_chars) ? capCfg.max_chars : 2200;
  const maxHashtagsTotal = Number.isFinite(capCfg.max_hashtags) ? capCfg.max_hashtags : 30;

  const marker = idemMarker(postId);

  let h = String(hook ?? '');
  let b = String(body ?? '');
  const c = String(cta ?? ''); // cta 는 어떤 단계에서도 줄이지 않는다(§3.12 규칙6).
  let tags = Array.isArray(hashtags) ? hashtags.filter((t) => typeof t === 'string' && t.length > 0) : [];

  const truncated = { body: false, hook: false, hashtags: false };

  // 규칙 1+2: 마커를 해시태그 배열 맨 뒤에 고정 예약 → 사용자 해시태그 유효 상한 = max-1.
  // 상한 초과분은 뒤에서부터 제거한다.
  const maxUserHashtags = Math.max(0, maxHashtagsTotal - 1);
  if (tags.length > maxUserHashtags) {
    tags = tags.slice(0, maxUserHashtags);
    truncated.hashtags = true;
  }

  const hashtagLine = () => [...tags, marker].join(' '); // marker 가 있어 절대 빈 문자열이 아니다.
  const compose = () => [h, b, c, hashtagLine()].filter((s) => s !== '' && s != null).join(SEP);

  let caption = compose();

  // 규칙 3+4: body 를 문장 경계로 우선 절삭.
  if (caption.length > maxChars) {
    const overflow = caption.length - maxChars;
    const budget = Math.max(0, b.length - overflow);
    const sentences = b.split(SENTENCE_BOUNDARY).filter(Boolean);
    let kept = '';
    for (const s of sentences) {
      const next = kept ? `${kept} ${s}` : s;
      if (next.length <= budget) kept = next;
      else break;
    }
    if (kept !== b) {
      b = kept; // 한 문장도 못 들어가면 kept==='' → body 통째로 비움.
      truncated.body = true;
    }
    caption = compose();
  }

  // 규칙 5: 그래도 넘치면 hook 을 어절 경계로 절삭.
  if (caption.length > maxChars) {
    const overflow = caption.length - maxChars;
    const budget = Math.max(0, h.length - overflow);
    const words = h.split(WORD_BOUNDARY).filter(Boolean);
    let kept = '';
    for (const w of words) {
      const next = kept ? `${kept} ${w}` : w;
      if (next.length <= budget) kept = next;
      else break;
    }
    if (kept !== h) {
      h = kept;
      truncated.hook = true;
    }
    caption = compose();
  }

  // 규칙 6: 그래도 넘치면 해시태그를 뒤에서부터 하나씩 제거. 마커·cta 는 최후까지 보존.
  while (caption.length > maxChars && tags.length > 0) {
    tags = tags.slice(0, -1);
    truncated.hashtags = true;
    caption = compose();
  }

  const hashtagCount = tags.length + 1; // +1 = 마커

  // 규칙 7: 불변식.
  if (caption.length > maxChars) throw new Error(`buildCaption: 절삭 후에도 ${caption.length}자 (한도 ${maxChars})`);
  if (hashtagCount > maxHashtagsTotal) throw new Error(`buildCaption: 해시태그 ${hashtagCount}개 (한도 ${maxHashtagsTotal})`);
  if (!caption.includes(c)) throw new Error('buildCaption: cta 유실');
  if (!caption.trimEnd().endsWith(marker)) throw new Error('buildCaption: 멱등 마커 유실');

  return { caption, chars: caption.length, hashtagCount, idemMarker: marker, truncated };
}
