/**
 * kernel/llm-failure.mjs — claude CLI 실패 분류 (순수함수)
 *
 * 왜 있는가(F-05): 같은 분류가 두 곳에 포크돼 있었다.
 *   - `shorts-curiosity/lib.mjs` → `classifyClaudeFailure` + `FAILURE_LABELS`
 *   - `cardnews/lib.mjs`         → `classifyFailure` + `FAILURE_KINDS` (위의 포크, 진단 메타 추가)
 * 정규식 테이블(`FAILURE_SIGNALS`)까지 바이트 동일하게 복제돼 있었다.
 *
 * 갈래가 둘이면 **같은 claude 가 같은 이유로 죽어도 두 채널이 다른 이름으로 기록하고
 * 다른 복구 정책을 적용한다.** claude 는 이 시스템의 유일한 LLM 공급원이고 36개 파일이
 * 이 의존을 만지므로, 최대 단일 장애원인에 어휘가 둘인 것은 그 자체가 결함이다.
 *
 * 여기서는 **진화한 쪽(cardnews 판, 진단 메타 포함)** 을 정본으로 삼는다.
 * 판정 순서·정규식·문구는 그대로다 — 값이 바뀌면 경보와 복구 정책이 바뀐다.
 *
 * 커널 규약: fs·child_process·Date 를 import 하지 않는다.
 */

/** 분류 결과의 가능한 값. 새 갈래를 늘리기 전에 복구 정책이 있는지 먼저 정한다. */
export const FAILURE_KINDS = Object.freeze(
  ['usage-limit', 'auth', 'cli-missing', 'timeout', 'network', 'unknown']
);

/**
 * 갈래 판별 신호.
 * ⚠ `usageLimit` 만 "즉시 포기" 권한을 갖는다 — 오진하면 발행이 죽으므로 문구를 좁게 유지한다.
 */
export const FAILURE_SIGNALS = Object.freeze({
  usageLimit: /usage limit|limit reached|limit exceeded|사용량 한도|한도에 도달|rate.?limit|quota|\b429\b|too many requests|credit balance|insufficient credit|out of credits|upgrade to continue/i,
  auth: /unauthorized|\b401\b|invalid api key|authentication[_ ]error|authentication failed|not logged in|login required|please run.{0,20}login|\/login|oauth.{0,20}expired|session expired|재로그인|로그인이 필요/i,
  cliMissing: /ENOENT|command not found|not found: claude|ETXTBSY/i,
  timeout: /\btimed out\b|\btimeout\b|ETIMEDOUT/i,
  network: /ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang up|fetch failed|network error|Connection closed|mid-response|overloaded|\b(500|502|503|504|529)\b/i,
});

/** 사람이 읽는 갈래 이름(경보 제목에 그대로 실린다). */
export const FAILURE_LABELS = Object.freeze({
  'usage-limit': '구독 사용량 한도 소진',
  auth: '인증 만료·로그인 필요',
  'cli-missing': 'claude CLI 실행 불가(부재·손상)',
  timeout: '응답 시간 초과',
  network: '네트워크·API 연결 실패',
  unknown: '원인 불명',
});

/**
 * claude 실패 분류 — stdout·stderr·exit code·signal 을 **함께** 본다.
 * 확실하지 않으면 unknown 으로 두고 원문을 남긴다(억지 분류가 오진을 만든다).
 *
 * 이 판정을 저장 필드로 남기는 것이 요건이다 — 2026-07-25 로그는
 * `Command failed: claude -p` 한 줄뿐이라 한도/CLI손상/네트워크를 사후 판별할 수 없었다.
 *
 * @typedef {object} FailureObservation
 * @property {string}  [stdout]     claude 표준출력(응답 봉투에 사유가 들어있는 경우가 많다)
 * @property {string}  [stderr]     claude 표준오류
 * @property {string}  [message]    던져진 Error 의 message
 * @property {number}  [status]     프로세스 종료코드
 * @property {string}  [signal]     종료 시그널(SIGTERM 이면 우리가 죽인 것)
 * @property {string}  [code]       Node 오류코드(ENOENT 등)
 * @property {boolean} [killed]     타임아웃으로 우리가 죽였는지
 * @property {boolean} [versionOk]  `claude --version` 이 되는지(CLI 손상 판별용)
 *
 * @typedef {object} FailureVerdict
 * @property {string} kind          FAILURE_KINDS 중 하나
 * @property {'high'|'medium'|'low'} confidence
 * @property {string|null} evidence 판정 근거가 된 원문 조각
 * @property {number|null} exit_code
 * @property {string|null} signal
 * @property {boolean} stderr_empty
 *
 * @param {FailureObservation} [p]
 * @returns {FailureVerdict}
 */
export function classifyFailure({ stdout = '', stderr = '', message = '', status, signal, code, killed, versionOk } = {}) {
  const blob = [message, stderr, stdout].map(x => (x == null ? '' : String(x))).filter(Boolean).join('\n');
  const hit = (re) => { const m = blob.match(re); return m ? String(m[0]).slice(0, 120) : null; };
  const meta = {
    exit_code: typeof status === 'number' ? status : null,
    signal: signal ?? null,
    stderr_empty: !String(stderr || '').trim(),
  };
  const verdict = (kind, confidence, evidence) => ({ kind, confidence, evidence, ...meta });

  // ① exec 자체가 못 뜬 ENOENT = CLI 부재 확정(다른 해석 여지 없음).
  if (code === 'ENOENT') return verdict('cli-missing', 'high', 'ENOENT — claude 바이너리를 찾지 못함');
  // ② 한도(확실 신호만). 짧은 백오프 재시도가 무의미한 유일한 갈래.
  const usage = hit(FAILURE_SIGNALS.usageLimit);
  if (usage) return verdict('usage-limit', 'high', usage);
  // ③ 인증
  const auth = hit(FAILURE_SIGNALS.auth);
  if (auth) return verdict('auth', 'high', auth);
  // ④ 버전 조회조차 실패 = CLI 자체 불가(API 를 타지 않는 호출이라 한도와 무관).
  if (versionOk === false) return verdict('cli-missing', 'medium', 'claude --version 실패');
  // ⑤ 타임아웃(우리가 SIGTERM 으로 죽인 경우 포함) → 네트워크보다 먼저 본다.
  if (killed === true || signal === 'SIGTERM' || hit(FAILURE_SIGNALS.timeout)) {
    const hard = killed === true || signal === 'SIGTERM';
    return verdict('timeout', hard ? 'high' : 'medium',
      hard ? `타임아웃으로 종료(signal=${signal || 'SIGTERM'})` : hit(FAILURE_SIGNALS.timeout));
  }
  const net = hit(FAILURE_SIGNALS.network);
  if (net) return verdict('network', 'medium', net);
  const cli = hit(FAILURE_SIGNALS.cliMissing);
  if (cli) return verdict('cli-missing', 'medium', cli);
  // ⑥ 모르면 모른다고 한다 — 원문은 diag 에 그대로 실린다.
  return verdict('unknown', 'low', null);
}

/**
 * 갈래별 사람 조치 문구(경보에 그대로 실린다).
 *
 * 채널마다 다른 것은 **딱 둘**이다 — 한도일 때 무엇이 대신 발행하는지(`fallbackNote`)와
 * 원인 불명일 때 어느 로그를 보라고 할지(`unknownAction`). 그 둘만 주입받고 나머지는
 * 공통이다. 커널이 "재고 폴백" 이나 "예비 대본 buffer" 를 알아야 할 이유는 없다.
 *
 * @param {string} kind
 * @param {object} [opts]
 * @param {string} [opts.fallbackNote]  한도 소진 시 대체 발행 경로 안내
 * @param {string} [opts.unknownAction] 원인 불명 시 문구 전체
 */
export function failureAction(kind, {
  fallbackNote  = '그 사이 발행은 폴백 경로가 담당한다.',
  unknownAction = '원인 불명 — 진단 로그 확인 필요.',
} = {}) {
  switch (kind) {
    case 'usage-limit':
      return `구독 사용량 한도로 판단 — 재시도해도 무의미하니 한도 리셋(보통 수 시간)까지 대기. ${fallbackNote}`;
    case 'auth':
      return '터미널에서 claude 를 한 번 실행해 로그인 상태를 확인(재로그인 필요). 인증이 풀리면 자동 복구되지 않는다.';
    case 'cli-missing':
      return 'claude CLI 가 없거나 손상 — PATH 확인 후 재설치. auto-update 중 순간 소실이면 다음 슬롯에 자동 복구된다.';
    case 'timeout':
      return '응답 시간 초과 — 다음 슬롯이 자동 재시도한다. 반복되면 회선·부하를 확인.';
    case 'network':
      return '네트워크·API 연결 실패 — 회선/DNS 확인. 일시적이면 다음 슬롯에 자동 복구된다.';
    default:
      return unknownAction;
  }
}
