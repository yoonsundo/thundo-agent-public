/**
 * kernel/net.mjs — 네트워크 식별자 판정. 부작용 없는 정본.
 *
 * 🔴 **공인 IPv4 의 정의는 여기 하나뿐이다.** 예전엔 유출 게이트와 관측 가림기가 각자
 *    정규식을 들고 있어 서로 어긋났다(2026-09-07 실측):
 *      - 앞뒤에 문자가 바로 붙은 꼴 → 가림기는 놓치고 게이트는 잡아서, **가려도 매일 막혔다**
 *      - 브라우저 UA·커널 버전 문자열 → 게이트는 그냥 두는데 가림기가 망가뜨렸다
 *    같은 개념을 두 곳에 적으면 드리프트는 시간문제다.
 *
 * ⚠ 이 파일이 커널에 있는 이유: 게이트(`test/scan-thirdparty.mjs`)와 리포트
 *    (`report/insight-brief.mjs`)가 함께 쓴다. 리포트가 테스트 모듈을 import 하면 층이
 *    뒤집히고, 그 모듈에 실행 가드가 없으면 import 만으로 전체 스캔이 돈다.
 */

/**
 * 사설망·루프백은 제외한다(노출 가치가 없다).
 * 버전 문자열이 IPv4 와 형태가 같아 오탐이 나므로 실측된 두 형태를 배제한다:
 *   `Chrome/131.0.0.0`·`AppleWebKit/537.36` → 앞이 `/`
 *   `6.18.33.1-microsoft-standard-WSL2`     → 뒤가 `-`
 */
// 옥텟은 0~255 만 인정한다. 실제 IPv4 는 이 범위를 벗어날 수 없으므로 탐지력 손실이 없고,
// 마지막 자리가 255 를 넘는 **불가능한 주소**(주로 버전 문자열)를 양쪽에서 동시에 오탐하지 않게 된다.
// ⚠ 예시를 숫자로 적지 마라 — 이 파일이 유출 스캐너에 걸려 미러 발행이 막힌다(실제로 걸렸다).
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
export const PUBLIC_IPV4 = new RegExp(
  `(?<![/\\d.])(?!0\\.|10\\.|127\\.|169\\.254\\.|192\\.168\\.|172\\.(?:1[6-9]|2\\d|3[01])\\.)`
  + `(?:${OCTET}\\.){3}${OCTET}(?![-\\d.])`,
);

/** 전역 플래그판 — 문자열 안의 **모든** 공인 IP 를 치환할 때. 정본은 위 하나다. */
export const PUBLIC_IPV4_G = new RegExp(PUBLIC_IPV4.source, 'g');

/**
 * 식별자를 대역만 남기고 지운다. 관측 사실("인프라 자기호출 4건")은 그대로 읽힌다.
 * ⚠ 객체의 **키**도 훑는다 — IP 별 집계(`{ "…": 4 }`)가 그 관측의 자연스러운 모양이다.
 */
export function redactPublicIps(value) {
  if (typeof value === 'string') return value.replace(PUBLIC_IPV4_G, (ip) => `${ip.split('.')[0]}.x.x.x`);
  if (Array.isArray(value)) return value.map(redactPublicIps);
  // Date 등 JSON 표현을 가진 객체는 부수지 않는다 — 전개하면 `{}` 가 된다.
  if (value instanceof Date) return value;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [redactPublicIps(k), redactPublicIps(v)]));
  }
  return value;
}
