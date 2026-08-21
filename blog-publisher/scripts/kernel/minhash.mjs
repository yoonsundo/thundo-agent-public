/**
 * kernel/minhash.mjs — 문자 4-gram MinHash (순수함수)
 *
 * `gates/check-dup.mjs` 에 인라인돼 있던 산출식을 그대로 옮긴 것이다.
 * **값이 바뀌면 게이트 판정이 바뀐다** — 성능 개선은 이 파일이 아니라 호출부의
 * 캐싱(`lib/dup-index.mjs`)으로 한다. 여기 손대려면 발행물 전수 재판정이 필요하다.
 *
 * 비용 구조(2026-08-21 실측): 4-gram 하나마다 sha256 을 k=128 회 돈다.
 * 발행물 1편 평균 2,262 gram → 약 320ms. 153편 전체면 약 49초.
 * 그래서 서명은 캐시하고, 매 실행에 새로 계산하는 것은 초안 1편뿐이어야 한다.
 *
 * 커널 규약: fs·child_process·Date 를 import 하지 않는다. 입력만 보고 값을 낸다.
 */
import { createHash } from 'node:crypto';

/** MinHash 서명 길이. 바꾸면 기존 인덱스가 전부 무효가 된다. */
export const SIG_K = 128;

/**
 * 문자 4-gram 집합. 공백은 하나로 접는다.
 * @param {string} text
 * @returns {Set<string>}
 */
export function charFourgrams(text) {
  const chars = [...text.replace(/\s+/g, ' ')];
  const grams = new Set();
  for (let i = 0; i <= chars.length - 4; i++) {
    grams.add(chars.slice(i, i + 4).join(''));
  }
  return grams;
}

/**
 * MinHash 서명. 해시 i 는 `sha256("i:gram")` 의 상위 32비트.
 * @param {Set<string>|Iterable<string>} grams
 * @param {number} k
 * @returns {number[]} 길이 k. gram 이 없으면 전부 Infinity.
 */
export function minHash(grams, k = SIG_K) {
  const sig = new Array(k).fill(Infinity);
  for (const gram of grams) {
    for (let i = 0; i < k; i++) {
      const val = createHash('sha256').update(`${i}:${gram}`).digest().readUInt32BE(0);
      if (val < sig[i]) sig[i] = val;
    }
  }
  return sig;
}

/**
 * 두 서명의 추정 Jaccard = 같은 자리 값이 일치하는 비율.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} 0~1
 */
export function jaccardFromSigs(a, b) {
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same / a.length;
}

/**
 * 서명 → base64. 저장용. Infinity 는 0xFFFFFFFF 로 접는다
 * (gram 이 하나라도 있으면 Infinity 는 나오지 않으므로 실사용에선 무손실이고,
 *  빈 문서는 애초에 호출부가 걸러낸다).
 * @param {number[]} sig
 * @returns {string}
 */
export function encodeSig(sig) {
  const buf = Buffer.alloc(sig.length * 4);
  for (let i = 0; i < sig.length; i++) {
    buf.writeUInt32BE(Number.isFinite(sig[i]) ? sig[i] >>> 0 : 0xFFFFFFFF, i * 4);
  }
  return buf.toString('base64');
}

/**
 * base64 → 서명. 길이가 SIG_K 와 다르면 null(= 캐시 무효로 취급).
 * @param {string} b64
 * @param {number} k
 * @returns {number[]|null}
 */
export function decodeSig(b64, k = SIG_K) {
  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch { return null; }
  if (buf.length !== k * 4) return null;
  const sig = new Array(k);
  for (let i = 0; i < k; i++) sig[i] = buf.readUInt32BE(i * 4);
  return sig;
}
