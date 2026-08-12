/**
 * shorts/captions.mjs — 키네틱(단어단위) 자막 로직 (순수 함수)
 *
 * "슬라이드쇼 탈피"의 시각 핵심 하나. 정적 한 줄 자막 대신, caption 을 2~3어절
 * 그룹으로 쪼개 성우 발화에 맞춰 그룹을 순차 하이라이트(카라오케 팝)한다.
 *
 * 이 모듈은 렌더(slides.mjs)와 타이밍(assemble.mjs)이 **동일한 그룹 분할**을 쓰도록
 * 순수 로직만 제공한다. 렌더는 그룹별 PNG 를, 조립은 그룹별 시간창을 만든다.
 * 한국어 렌더 품질은 기존 chromium+Pretendard 임베드가 100% 담당(레퍼런스 근거).
 */

/** caption 을 어절 기준 그룹으로 분할. 각 그룹 groupWords 어절(기본 2). */
export function splitGroups(caption, groupWords = 2) {
  const words = String(caption || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const g = Math.max(1, groupWords | 0);
  const groups = [];
  for (let i = 0; i < words.length; i += g) groups.push(words.slice(i, i + g).join(' '));
  return groups;
}

/**
 * 그룹별 시간창(세그먼트 로컬 초). 오디오 구간[padHead, padHead+audioDur]를 그룹 수로
 * 균등 분할하되, 첫 그룹은 0(선두 패드부터)·마지막 그룹은 세그먼트 끝까지 늘려 공백을 없앤다.
 * @returns {{start:number,end:number}[]}
 */
export function groupTimings(nGroups, segDurSec, audioDurSec, padHead = 0.3) {
  if (nGroups <= 0) return [];
  const speechStart = Math.min(padHead, segDurSec);
  const speechEnd = Math.min(padHead + audioDurSec, segDurSec);
  const span = Math.max(0.001, speechEnd - speechStart);
  const step = span / nGroups;
  const t = [];
  for (let i = 0; i < nGroups; i++) {
    const start = i === 0 ? 0 : speechStart + i * step;
    const end = i === nGroups - 1 ? segDurSec : speechStart + (i + 1) * step;
    t.push({ start: +start.toFixed(3), end: +end.toFixed(3) });
  }
  return t;
}

/** 키네틱 자막 활성 여부(config). 기본 on. */
export function kineticEnabled(cfg) {
  return cfg?.captions?.kinetic !== false;
}
