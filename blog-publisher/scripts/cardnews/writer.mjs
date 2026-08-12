#!/usr/bin/env node
/**
 * cardnews/writer.mjs — 이중 생성(클로드 · 코덱스) 작가 배정
 *
 * 근거: `.omc/specs/deep-interview-cardnews-dual-generator.md` (2026-07-31 확정)
 *
 * 하루 2편을 **서로 다른 소재**로 내되, 슬롯 시각으로 작가를 결정론 배정한다
 * (11시=클로드 · 19시=코덱스). 코덱스는 폴백이 아니라 **정식 작가**다 — 도입 이유가
 * ①클로드 사용량 분산 ②문체 다양성이므로, 코덱스를 예비로 두면 둘 다 얻지 못한다.
 *
 * 다만 코덱스가 실패한 날은 **클로드가 대신 쓴다**(사용자 결정). 그날은 문체 다양성과
 * 사용량 분산이 깨지지만 "매일 2편"이 우선한다.
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeLogger } from '../lib/log.mjs';
import { REPO_ROOT, stateRoot, callClaude as libCallClaude } from './lib.mjs';

const log = makeLogger('cardnews/writer');

export const GENERATORS = ['claude', 'codex'];

// ── 코덱스 호출 예산 ─────────────────────────────────────────────────────────
//
// 🔴 클로드 원장(`budget.max_claude_calls_per_run`)과 **별도로** 센다. 같은 카운터에
// 합치면 코덱스로 옮긴 만큼 클로드 예산이 줄어들어, 사용량 분산의 효과가 장부에서
// 사라진다 — 분산이 목적인데 측정이 안 되면 도입 자체를 평가할 수 없다.
//
// ⚠ 세는 지점은 `callCodex`(CLI 래퍼)가 아니라 `makeWriter`(라우팅)다. 알고 싶은 것은
// "우리 CLI 래퍼가 몇 번 돌았나"가 아니라 **"클로드 대신 코덱스로 보낸 호출이 몇 건인가"**
// 이고, 후자는 구현을 바꿔 끼워도 변하지 않아야 한다.
let codexCalls = 0;
export function codexCallCount() { return codexCalls; }
export function resetCodexCalls() { codexCalls = 0; return 0; }

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms | 0)); }
  catch { /* SAB 미지원 환경 무시 */ }
}

function excerpt(v, n = 600) {
  const s = v == null ? '' : String(v);
  return s.length > n ? s.slice(0, n) + `…(총 ${s.length}자)` : s;
}

/**
 * 코덱스 실패 분류 — 한도 소진이 확실하면 재시도를 태우지 않는다(지연만 늘고 결과는 같다).
 * @returns {{kind:'usage-limit'|'auth'|'transient'|'unknown', evidence:string}}
 */
export function classifyCodexFailure({ stdout = '', stderr = '', message = '', code = null } = {}) {
  const blob = `${code || ''} ${message || ''} ${stderr || ''} ${stdout || ''}`;
  if (/usage limit|rate limit|quota exceeded|too many requests|\b429\b/i.test(blob)) {
    return { kind: 'usage-limit', evidence: excerpt(blob, 200) };
  }
  if (/not logged in|unauthorized|authentication|\b401\b|\b403\b|codex login/i.test(blob)) {
    return { kind: 'auth', evidence: excerpt(blob, 200) };
  }
  if (/ENOENT|ETXTBSY|EAGAIN|timeout|Connection closed|overloaded|\b(500|502|503|504|529)\b/i.test(blob)) {
    return { kind: 'transient', evidence: excerpt(blob, 200) };
  }
  return { kind: 'unknown', evidence: excerpt(blob, 200) };
}

/**
 * 코덱스가 결과를 쓸 임시파일 경로.
 *
 * 🔴 **레포 아래여야 한다.** codex 는 이 박스에서 snap 으로 설치돼 있어 `/tmp` 가 private
 * namespace 다 — `/tmp` 경로로 `-o` 를 주면 CLI 가 `Failed to write last message file …
 * (os error 2)` 를 찍고도 **종료코드 0으로 끝난다**. 결과만 조용히 사라지는 것이다.
 * (실측 2026-07-31.) 그래서 경로를 레포로 강제하고, 파일이 없으면 아래에서 명시적으로 던진다.
 */
export function codexTmpPath(n = 0, { root = null } = {}) {
  const base = root || stateRoot();
  const dir = isAbsolute(base) && !relative(REPO_ROOT, base).startsWith('..')
    ? join(base, 'tmp')
    : join(REPO_ROOT, 'state', 'cardnews', 'tmp');
  mkdirSync(dir, { recursive: true });
  return join(dir, `codex-${process.pid}-${Date.now()}-${n}.txt`);
}

/**
 * 코덱스 CLI 호출 → 최종 응답 텍스트(코드펜스 제거).
 *
 * `callClaude` 와 **같은 계약**이다: 성공하면 문자열, 실패하면 throw(err.diag 첨부).
 * 그래야 `deps.callClaude` 주입점에 그대로 꽂힌다.
 *
 * @param {string} prompt
 * @param {object} [opt]
 * @param {number} [opt.retries] 기본 2 (env `CARDNEWS_CODEX_RETRIES`)
 * @param {function} [opt.exec] 테스트 주입점 — 기본 `execFileSync`
 * @param {function} [opt.readOut] 테스트 주입점 — 결과파일 읽기
 * @param {object} [opt.cfg] `generators.codex.*` 조회용
 */
export function callCodex(prompt, {
  retries, retryBaseMs = 4000, exec = execFileSync, readOut = null, cfg = null,
  tmpPath = codexTmpPath, timeoutMs = null,
} = {}) {
  const gc = cfg?.generators?.codex || {};
  const bin = gc.bin || 'codex';
  const maxRetries = Number.isFinite(retries) ? retries
    : (Number.isFinite(parseInt(process.env.CARDNEWS_CODEX_RETRIES, 10))
      ? parseInt(process.env.CARDNEWS_CODEX_RETRIES, 10) : 2);
  const timeout = Number(timeoutMs ?? gc.timeout_ms ?? 300_000);
  const startedAt = Date.now();

  const fail = (raw, attempt, abort = null) => {
    const cls = classifyCodexFailure(raw);
    const diag = {
      at: new Date().toISOString(), source: 'cardnews/callCodex',
      kind: cls.kind, evidence: cls.evidence, aborted_early: abort,
      attempts: attempt + 1, max_attempts: maxRetries + 1,
      elapsed_ms: Date.now() - startedAt, calls_used: codexCalls,
      message: excerpt(raw.message, 300), stderr_excerpt: excerpt(raw.stderr),
    };
    log.error(`codex 실패 진단 [${diag.kind}]`, diag);
    const err = new Error(`codex 실행 실패(${diag.kind}): ${raw.message || 'no message'}`);
    err.diag = diag;
    return err;
  };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const out = tmpPath(attempt);
    // `-C REPO_ROOT` 기준 상대경로로 넘긴다 — snap 격리에서 실측으로 통과한 형태다.
    const rel = relative(REPO_ROOT, out) || out;
    const args = [
      'exec', '--sandbox', 'read-only', '-C', REPO_ROOT,
      '--ephemeral', '--color', 'never', '-o', rel,
    ];
    if (gc.model) args.push('-m', String(gc.model));
    args.push('-');

    let raw = null;
    try {
      exec(bin, args, { input: prompt, encoding: 'utf8', timeout, maxBuffer: 40 * 1024 * 1024 });
    } catch (e) {
      try { rmSync(out, { force: true }); } catch { /* 정리 실패 무시 */ }
      const obs = { message: e.message, stderr: e.stderr, stdout: e.stdout, code: e.code };
      const cls = classifyCodexFailure(obs);
      if (cls.kind === 'usage-limit' || cls.kind === 'auth') {
        throw fail(obs, attempt, `${cls.kind}(확실) — 재시도 생략`);
      }
      if (attempt < maxRetries) { sleepSync(retryBaseMs * (attempt + 1)); continue; }
      throw fail(obs, attempt);
    }

    // ⚠ 종료코드 0 이어도 결과가 없을 수 있다(snap /tmp 함정). **비어있으면 실패다.**
    try {
      raw = readOut ? readOut(out) : readFileSync(out, 'utf8');
    } catch (e) {
      raw = null;
      if (!readOut) log.warn(`codex 결과파일 읽기 실패: ${e.message}`);
    } finally {
      try { rmSync(out, { force: true }); } catch { /* 정리 실패 무시 */ }
    }

    const text = String(raw ?? '').trim();
    if (!text) {
      const obs = {
        message: `codex 결과 비어있음 (종료코드 0, 출력파일 ${rel}). `
          + 'snap 격리로 결과파일이 쓰이지 않았을 수 있다.',
        stderr: '', stdout: '',
      };
      if (attempt < maxRetries) { sleepSync(retryBaseMs * (attempt + 1)); continue; }
      throw fail(obs, attempt);
    }
    return text.replace(/^```\w*\r?\n?/, '').replace(/\r?\n?```\s*$/, '').trim();
  }
  throw new Error('codex: 재시도 소진');
}

// ── 배정 ─────────────────────────────────────────────────────────────────────

/**
 * 슬롯 시각 → 작가.
 *
 * `generators.by_hour` 에 정확히 일치하는 시각이 있으면 그것, 없으면 `generators.default`.
 * `generators.enabled=false` 면 항상 클로드(비상 스위치 — 코덱스 쪽이 통째로 망가진 날
 * config 한 줄로 원복한다).
 *
 * @param {object} cfg
 * @param {Date} when KST 기준으로 시각을 읽는다
 */
export function resolveGenerator(cfg, when = new Date()) {
  const g = cfg?.generators || {};
  if (g.enabled === false) return 'claude';
  // ⚠ `hour12:false` 만으로는 로케일에 따라 자정이 **'24'** 로 나온다 — `slotKey` 가 이미
  // 같은 이유로 en-GB + h23 을 못박아 뒀다. 여기서 형식이 어긋나면 `by_hour` 키가 영영
  // 일치하지 않아 배정이 조용히 default 로만 떨어진다(코덱스가 한 번도 안 불린다).
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul', hour: '2-digit', hourCycle: 'h23',
  }).format(new Date(when)));
  const picked = g.by_hour?.[String(hour)] ?? g.default ?? 'claude';
  return GENERATORS.includes(picked) ? picked : 'claude';
}

/** 이 단계를 코덱스에 넘기는가. 기본은 `script` 만. */
export function stageUsesCodex(cfg, stage) {
  const stages = cfg?.generators?.stages;
  return Array.isArray(stages) ? stages.includes(stage) : stage === 'script';
}

/**
 * 단계용 호출자를 만든다.
 *
 * 코덱스가 배정됐고 그 단계가 코덱스 대상이면 코덱스로 부르고, **실패하면 클로드로
 * 다시 부른다**(사용자 결정: 매일 2편 우선). 폴백이 일어나면 `onFallback` 으로 알린다 —
 * 호출자가 런 기록에 남겨야 "왜 오늘은 두 편이 같은 문체인가"를 나중에 설명할 수 있다.
 *
 * @returns {{generator:string, call:function}} `call` 은 callClaude 와 같은 계약
 */
export function makeWriter(stage, {
  cfg = null, generator = 'claude', callClaude = libCallClaude, callCodexImpl = callCodex,
  onFallback = null,
} = {}) {
  const useCodex = generator === 'codex' && stageUsesCodex(cfg, stage);
  if (!useCodex) return { generator: 'claude', call: callClaude };

  const call = (prompt, opt = {}) => {
    codexCalls += 1;
    try {
      return callCodexImpl(prompt, { ...opt, cfg });
    } catch (e) {
      log.warn(`코덱스 ${stage} 실패 → 클로드로 대체: ${e.message}`);
      try { onFallback?.({ stage, reason: e.diag?.kind ?? 'unknown', message: e.message }); }
      catch (e2) { log.warn(`폴백 기록 실패(비차단): ${e2.message}`); }
      return callClaude(prompt, opt);
    }
  };
  return { generator: 'codex', call };
}
