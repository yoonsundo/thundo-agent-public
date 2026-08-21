/**
 * lib/claude-runner.mjs — claude CLI 호출 공용 러너 (F-05)
 *
 * 왜 있는가: `claude` 는 이 시스템의 유일한 LLM 공급원이고 36개 파일이 이 의존을 만진다.
 * 그런데 호출 구현이 4개로 포크돼 있었다 — `cardnews/lib.mjs`, `shorts-curiosity/lib.mjs`,
 * `shorts/script.mjs`, `naver/rewrite-for-naver.mjs`. 재시도·백오프·한도 조기포기·진단 조립·
 * 응답 봉투 파싱이 전부 복제였다(실제로 envelope 처리부는 **바이트 동일**했다).
 *
 * 최대 단일 장애원인에 고칠 지점이 넷이면 고쳐지지 않는다. 여기가 정본이다.
 *
 * 채널마다 진짜로 다른 것은 **정책**뿐이라, 그것만 주입받는다:
 *   - 진단에 남길 출처 이름(`source`)과 재시도 수를 읽는 환경변수
 *   - 호출 전 훅(`beforeCall`) — 카드뉴스의 예산 차감이 여기 붙는다
 *   - 진단 추가 필드(`extraDiag`) — 카드뉴스의 label·calls_used
 *   - 실패 문구(`actionFor`)와 기록 위치(`recordFailure`)
 *
 * 실행 인자(`-p --output-format json --dangerously-skip-permissions`)·타임아웃·백오프
 * 곡선·조기포기 조건은 **공통**이고 바꾸지 않았다. 값이 바뀌면 발행이 바뀐다.
 */
import { execFileSync } from 'node:child_process';

import { classifyFailure } from '../kernel/llm-failure.mjs';
import { subscriptionEnv } from './claude-cli.mjs';

/** 진단에 싣는 발췌 — 원문이 길면 자르되 전체 길이를 남긴다. */
export function excerpt(v, n = 600) {
  const s = v == null ? '' : String(v);
  return s.length > n ? s.slice(0, n) + `…(총 ${s.length}자)` : s;
}

/**
 * 동기 sleep. 이 경로는 `execFileSync` 기반이라 async 로 바꿀 수 없다
 * (호출부가 전부 동기다 — 비동기화는 Phase 2 범위 밖의 별도 이관이다).
 */
export function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms | 0)); } catch { /* SAB 미지원 환경 무시 */ }
}

/** CLI 자체가 뜨는지 확인 — API 를 타지 않으므로 한도와 무관하게 CLI 손상을 가려낸다. */
export function probeClaudeVersion({ exec = execFileSync } = {}) {
  try {
    const out = exec('claude', ['--version'], { encoding: 'utf8', timeout: 20_000 });
    return { ok: true, version: String(out).trim().slice(0, 80) };
  } catch (e) {
    return { ok: false, error: `${e.code || ''} ${e.message || ''}`.trim().slice(0, 200) };
  }
}

/** 일시적 실패로 보고 재시도할 신호. 좁게 유지한다 — 넓히면 한도 소진 때 헛돈다. */
const TRANSIENT = /ENOENT|ETXTBSY|EAGAIN|Command failed|timeout|Connection closed|mid-response|overloaded|too many requests|\b(429|500|502|503|504|529)\b/i;

const CLAUDE_ARGS = ['-p', '--output-format', 'json', '--dangerously-skip-permissions'];

/**
 * 구독 인증 강제 — 자식 env 에서 `ANTHROPIC_API_KEY` 를 지운다.
 *
 * `claude` CLI 는 env 에 키가 있으면 **종량제로 과금**하고, 없으면 구독(OAuth) 로그인을 쓴다.
 * 지금까지 이 강제는 `lib/force-subscription.mjs` 를 **호출부마다 import** 하는 방식이었다
 * (19개 파일). 즉 새 호출부가 그 한 줄을 빠뜨리면 조용히 과금된다 — 실패가 눈에 안 띄는
 * 종류라 더 위험하다. 러너가 유일한 초크포인트가 됐으므로 여기서 강제한다.
 *
 * 전역 `process.env` 를 건드리지 않고 **자식 env 만** 정리한다(부작용 없는 쪽이 옳다).
 */
function childEnv() {
  return subscriptionEnv();
}

/**
 * 채널 정책을 받아 `callClaude(prompt, opts)` 를 만든다.
 *
 * @param {object} policy
 * @param {string}   policy.source          진단 `source` 필드 (예: 'curiosity/callClaude')
 * @param {string}   policy.retriesEnvVar   재시도 수를 읽을 환경변수 이름
 * @param {Function} policy.actionFor       (kind) => 사람 조치 문구
 * @param {Function} policy.recordFailure   (diag) => void — 진단 파일 기록
 * @param {{error:Function, warn?:Function, info?:Function}} policy.log  makeLogger 인스턴스
 * @param {number}  [policy.defaultRetries=3]
 * @param {number}  [policy.defaultTimeoutMs=300000]
 * @param {Function}[policy.beforeCall]     (opts) => void — 예산 차감 등. throw 하면 CLI 를 띄우지 않는다
 * @param {Function}[policy.extraDiag]      (cls) => object — 진단에 얹을 채널 필드
 * @returns {Function} callClaude(prompt, opts) => string
 */
export function makeClaudeRunner({
  source, retriesEnvVar, actionFor, recordFailure, log,
  defaultRetries = 3, defaultTimeoutMs = 300_000,
  beforeCall = () => {}, extraDiag = () => ({}),
}) {
  return function callClaude(prompt, opts = {}) {
    const {
      retries, retryBaseMs = 4000, timeoutMs = defaultTimeoutMs,
      exec = execFileSync, versionProbe = probeClaudeVersion,
      onFailure = recordFailure, ...rest
    } = opts;

    // 호출 전 훅이 먼저 — 상한을 넘긴 호출은 CLI 를 띄우지도 않는다.
    beforeCall(rest);

    const envRetries = parseInt(process.env[retriesEnvVar], 10);
    const maxRetries = Number.isFinite(retries) ? retries
      : (Number.isFinite(envRetries) ? envRetries : defaultRetries);
    const startedAt = Date.now();
    let lastErr;
    let versionInfo = null;   // 실패 시 1회만 조회

    /** 실패 확정 — 진단 조립 → 구조화 로그 → 파일 기록 → err.diag 첨부해 반환. */
    const fail = (raw, { attempt, abort = null }) => {
      if (!versionInfo) versionInfo = versionProbe({ exec });
      const cls = classifyFailure({ ...raw, versionOk: versionInfo.ok });
      const diag = {
        at: new Date().toISOString(),
        source,
        kind: cls.kind,
        confidence: cls.confidence,
        evidence: cls.evidence,
        action: actionFor(cls.kind),
        exit_code: raw.status ?? null,
        signal: raw.signal ?? null,
        error_code: raw.code ?? null,
        attempts: attempt + 1,
        max_attempts: maxRetries + 1,
        aborted_early: abort,
        elapsed_ms: Date.now() - startedAt,
        cli_version: versionInfo.ok ? versionInfo.version : null,
        cli_probe_error: versionInfo.ok ? null : versionInfo.error,
        message: excerpt(raw.message, 300),
        stderr_excerpt: excerpt(raw.stderr),
        stdout_excerpt: excerpt(raw.stdout),
        stderr_empty: !String(raw.stderr || '').trim(),
        ...extraDiag(cls),
      };
      // 구조화 로그 — 원문·분류·신호를 한 줄에 담아 runs/*.log 에서 사후 추적 가능하게.
      log.error(`claude 실패 진단 [${diag.kind}/${diag.confidence}]`, diag);
      try { onFailure(diag); } catch { /* 기록 실패 비차단 */ }
      /** @type {Error & {diag?: object}} */
      const err = new Error(`claude 실행 실패(${diag.kind}): ${raw.message || 'no message'}${diag.stderr_empty ? ' :: stderr 비어있음' : ' :: ' + excerpt(raw.stderr, 300)}`);
      err.diag = diag;   // 호출부가 갈래별로 분기할 수 있게 진단을 실어 보낸다
      return err;
    };

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let raw;
      try {
        raw = exec('claude', CLAUDE_ARGS, {
          input: prompt, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 40 * 1024 * 1024,
          env: childEnv(),
        });
      } catch (e) {
        lastErr = e;
        const obs = { message: e.message, stderr: e.stderr, stdout: e.stdout, status: e.status, signal: e.signal, code: e.code, killed: e.killed };
        // 확실한 한도 신호면 4s·8s·12s 백오프는 무의미(슬롯만 지연) → 즉시 포기하고 경보로 넘긴다.
        // ⚠ 'high' 확신일 때만 — 오분류로 발행이 죽지 않게 보수적으로.
        const early = classifyFailure({ ...obs, versionOk: true });
        if (early.kind === 'usage-limit' && early.confidence === 'high') {
          throw fail(obs, { attempt, abort: 'usage-limit(확실) — 재시도 생략' });
        }
        // ENOENT(바이너리 소실)·비정상종료(Command failed)·타임아웃·과부하 = 일시적 → 재시도.
        const blob = `${e.code || ''} ${e.message || ''} ${e.stderr || ''}`;
        const transient = e.code === 'ENOENT' || TRANSIENT.test(blob);
        if (attempt < maxRetries && transient) {
          sleepSync(retryBaseMs * (attempt + 1));   // 4s·8s·12s — claude 재설치 완료 대기
          continue;
        }
        throw fail(obs, { attempt });
      }

      let env;
      try { env = JSON.parse(raw); } catch {
        throw fail({ message: 'claude --output-format json 파싱 실패', stdout: raw, stderr: '', status: 0 }, { attempt });
      }
      if (env.is_error || env.subtype !== 'success' || typeof env.result !== 'string') {
        // 응답 레벨 오류 — stdout(JSON) 에 진짜 사유가 들어있는 경우가 많다(stderr 는 비어있음).
        const obs = {
          message: `claude 응답 오류: subtype=${env.subtype}${env.is_error ? ', is_error=true' : ''}`,
          stdout: typeof raw === 'string' ? raw : JSON.stringify(env), stderr: '', status: 0,
        };
        const early = classifyFailure({ ...obs, versionOk: true });
        if (early.kind === 'usage-limit' && early.confidence === 'high') {
          throw fail(obs, { attempt, abort: 'usage-limit(확실) — 재시도 생략' });
        }
        lastErr = new Error(obs.message);
        if (attempt < maxRetries) { sleepSync(retryBaseMs * (attempt + 1)); continue; }
        throw fail(obs, { attempt });
      }
      return env.result.replace(/^```\w*\r?\n?/, '').replace(/\r?\n?```\s*$/, '').trim();
    }
    throw lastErr;
  };
}
