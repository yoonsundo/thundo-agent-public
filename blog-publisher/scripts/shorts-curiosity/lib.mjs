/**
 * shorts-curiosity/lib.mjs — 독립 "설마 진짜?" 호기심 쇼츠 채널 공용 유틸
 *
 * 주제 백로그(경량 JSONL) + produced 인덱스 + 설정 + 구독 claude 호출 헬퍼.
 * 제작(대본→이미지→더빙→영상)은 scripts/shorts/ 엔진을 재사용한다(여긴 소재·선정·검증 레이어).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { paths } from '../lib/config.mjs';
import { makeLogger } from '../lib/log.mjs';

const log = makeLogger('curiosity/lib');

const __dir = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dir, '../../');

export function configPath() {
  return process.env.CURIOSITY_CONFIG_OVERRIDE || join(REPO_ROOT, 'config', 'shorts-curiosity.json');
}
export function loadConfig() {
  const cfg = JSON.parse(readFileSync(configPath(), 'utf8'));
  if (!cfg.pick || !cfg.backlog) throw new Error('shorts-curiosity.json: pick/backlog 필수');
  return cfg;
}

export function backlogDir() { return join(paths.state, 'shorts-backlog'); }
export function backlogPath() { return join(backlogDir(), 'backlog.jsonl'); }
export function indexPath() { return join(paths.state, 'shorts-curiosity-index.json'); }

/** 백로그 전체 로드 → [{id, subject, common_belief, reveal, domain, source_hint, status, ...}] */
export function loadBacklog() {
  const p = backlogPath();
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

export function appendBacklog(items) {
  mkdirSync(backlogDir(), { recursive: true });
  for (const it of items) appendFileSync(backlogPath(), JSON.stringify(it) + '\n', 'utf8');
}

/** produced/skip 상태 인덱스 — { <id>: { status:'produced'|'skipped'|'held', at, reason?, video? } } */
export function loadIndex() {
  const p = indexPath();
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')) || {}; } catch { return {}; }
}
export function saveIndex(idx) {
  mkdirSync(dirname(indexPath()), { recursive: true });
  writeFileSync(indexPath(), JSON.stringify(idx, null, 2) + '\n', 'utf8');
}
export function markStatus(id, status, extra = {}) {
  const idx = loadIndex();
  idx[id] = { ...(idx[id] || {}), status, at: new Date().toISOString(), ...extra };
  saveIndex(idx);
  return idx[id];
}

/** 아직 제작/폐기 안 된 백로그 항목.
 *  held 는 재시도 대상이나, **팩트체크로 2회 이상 보류(factcheck_fails>=2)** 된 건 지속적
 *  사실성 문제라 재선정해도 계속 탈락한다 — 이런 항목이 surprise 점수로 매 슬롯 pick 을
 *  독점해 3회 시도를 모두 태우고 폴백(구재고 재발행)을 유발하는 걸 막기 위해 제외한다
 *  (2026-07-17 사용자 지적). 단 factcheck 는 doubtful↔ok 로 흔들리므로(플레이키) 1회 보류는
 *  재시도로 남긴다. produce 등 일시 사유의 held 도 재시도. produced/uploaded/retired 는 제외. */
export function pendingBacklog() {
  const idx = loadIndex();
  return loadBacklog().filter(it => {
    const e = idx[it.id];
    if (!e) return true;                       // 미제작 신규
    if (e.status !== 'held') return false;     // produced/uploaded/retired 제외
    if (String(e.reason || '').startsWith('factcheck:')) return (e.factcheck_fails || 0) < 2;
    return true;                               // produce 등 일시 사유 held 는 재시도
  });
}

/** slug 안전화 (한글 제거 → id 기반) */
export function slugify(id) {
  return `curio-${String(id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'item'}`;
}

/** 동기 sleep(ms) — execFileSync 기반 callClaude 백오프용(외부 프로세스·PATH 의존 없음). */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms | 0)); } catch { /* SAB 미지원 환경 무시 */ }
}

// ─── claude 실패 진단 (2026-07-30 신설) ──────────────────────────────────────
//
// 왜: 2026-07-25·26 에 6개 슬롯이 전멸(하루 3편 → 0편 × 2일)했는데 남은 증거가
// `claude 실행 실패: Command failed: claude -p …` 한 줄뿐이었다. **stderr 가 비어 있어서**
// 한도 소진인지·CLI 손상인지·네트워크인지 32시간이 지난 지금도 모른다.
// execFileSync 는 exit code(status)·signal·**stdout** 도 주는데 그걸 안 봤다.
// `--output-format json` 이므로 오류는 stderr 가 아니라 **stdout JSON** 으로 나올 가능성이 크다.

/** 분류 신호. 억지 분류 금지 — 확실한 문구만 넣고 나머지는 unknown 으로 흘린다. */
const FAILURE_SIGNALS = Object.freeze({
  // 한도·과금 (이 갈래만 "즉시 포기" 권한을 갖는다 → 오진하면 발행이 죽으니 문구를 좁게 유지)
  usageLimit: /usage limit|limit reached|limit exceeded|사용량 한도|한도에 도달|rate.?limit|quota|\b429\b|too many requests|credit balance|insufficient credit|out of credits|upgrade to continue/i,
  auth: /unauthorized|\b401\b|invalid api key|authentication[_ ]error|authentication failed|not logged in|login required|please run.{0,20}login|\/login|oauth.{0,20}expired|session expired|재로그인|로그인이 필요/i,
  cliMissing: /ENOENT|command not found|not found: claude|ETXTBSY/i,
  timeout: /\btimed out\b|\btimeout\b|ETIMEDOUT/i,
  network: /ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang up|fetch failed|network error|Connection closed|mid-response|overloaded|\b(500|502|503|504|529)\b/i,
});

/** 사람이 읽는 갈래 라벨(경보 본문용). */
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
 * @param {object} p {stdout, stderr, message, status, signal, code, killed, versionOk}
 * @returns {{kind:string, confidence:'high'|'medium'|'low', evidence:string|null}}
 */
export function classifyClaudeFailure({ stdout = '', stderr = '', message = '', status, signal, code, killed, versionOk } = {}) {
  const blob = [message, stderr, stdout].map(x => (x == null ? '' : String(x))).filter(Boolean).join('\n');
  const hit = (re) => { const m = blob.match(re); return m ? String(m[0]).slice(0, 120) : null; };

  // ① exec 자체가 못 뜬 ENOENT = CLI 부재 확정(다른 해석 여지 없음).
  if (code === 'ENOENT') return { kind: 'cli-missing', confidence: 'high', evidence: 'ENOENT — claude 바이너리를 찾지 못함' };
  // ② 한도(확실 신호만). 짧은 백오프 재시도가 무의미한 유일한 갈래.
  const usage = hit(FAILURE_SIGNALS.usageLimit);
  if (usage) return { kind: 'usage-limit', confidence: 'high', evidence: usage };
  // ③ 인증
  const auth = hit(FAILURE_SIGNALS.auth);
  if (auth) return { kind: 'auth', confidence: 'high', evidence: auth };
  // ④ 버전 조회조차 실패 = CLI 자체 불가(API 를 타지 않는 호출이라 한도와 무관).
  if (versionOk === false) return { kind: 'cli-missing', confidence: 'medium', evidence: 'claude --version 실패' };
  // ⑤ 타임아웃(우리가 SIGTERM 으로 죽인 경우 포함) → 네트워크보다 먼저 본다.
  if (killed === true || signal === 'SIGTERM' || hit(FAILURE_SIGNALS.timeout)) {
    return { kind: 'timeout', confidence: killed || signal === 'SIGTERM' ? 'high' : 'medium', evidence: killed || signal === 'SIGTERM' ? `타임아웃으로 종료(signal=${signal || 'SIGTERM'})` : hit(FAILURE_SIGNALS.timeout) };
  }
  const net = hit(FAILURE_SIGNALS.network);
  if (net) return { kind: 'network', confidence: 'medium', evidence: net };
  const cli = hit(FAILURE_SIGNALS.cliMissing);
  if (cli) return { kind: 'cli-missing', confidence: 'medium', evidence: cli };
  // ⑥ 모르면 모른다고 한다 — 원문은 diag 에 그대로 실린다.
  return { kind: 'unknown', confidence: 'low', evidence: null };
}

/** 갈래별 사람 조치 문구(경보에 그대로 실린다). */
export function failureAction(kind) {
  switch (kind) {
    case 'usage-limit':
      return '구독 사용량 한도로 판단 — 재시도해도 무의미하니 한도 리셋(보통 수 시간)까지 대기. 그 사이 발행은 재고 폴백이 담당한다.';
    case 'auth':
      return '터미널에서 claude 를 한 번 실행해 로그인 상태를 확인(재로그인 필요). 인증이 풀리면 자동 복구되지 않는다.';
    case 'cli-missing':
      return 'claude CLI 가 없거나 손상 — PATH 확인 후 재설치. auto-update 중 순간 소실이면 다음 슬롯에 자동 복구된다.';
    case 'timeout':
      return '응답 시간 초과 — 다음 슬롯이 자동 재시도한다. 반복되면 회선·부하를 확인.';
    case 'network':
      return '네트워크·API 연결 실패 — 회선/DNS 확인. 일시적이면 다음 슬롯에 자동 복구된다.';
    default:
      return '원인 불명 — 진단 로그 확인 필요: runs/curiosity-slot-<날짜>.log 와 state/shorts-curiosity/last-claude-failure.json';
  }
}

/** 최근 claude 실패 진단 저장 경로 — 경보가 사후에 원인을 붙일 수 있게 남긴다. */
export function claudeFailurePath() {
  return join(paths.state, 'shorts-curiosity', 'last-claude-failure.json');
}

/** 진단 기록(베스트에포트 — 기록 실패가 발행을 죽이지 않는다). */
export function recordClaudeFailure(diag) {
  try {
    mkdirSync(dirname(claudeFailurePath()), { recursive: true });
    writeFileSync(claudeFailurePath(), JSON.stringify(diag, null, 2) + '\n', 'utf8');
  } catch (e) {
    log.warn(`claude 실패 진단 기록 실패(비차단): ${e.message}`);
  }
  return diag;
}

/**
 * 최근 claude 실패 진단 로드. 오래된 진단으로 오늘 결방을 오진하지 않도록 maxAgeMs 로 자른다.
 * @returns {object|null}
 */
export function loadLastClaudeFailure({ maxAgeMs = 45 * 60 * 1000 } = {}) {
  try {
    const p = claudeFailurePath();
    if (!existsSync(p)) return null;
    const d = JSON.parse(readFileSync(p, 'utf8'));
    if (!d || !d.at) return null;
    if (Date.now() - new Date(d.at).getTime() > maxAgeMs) return null;
    return d;
  } catch { return null; }
}

/** claude CLI 자체가 뜨는지 확인(API 미경유) — 실패하면 "CLI 자체 불가" 판정 근거. */
export function probeClaudeVersion({ exec = execFileSync } = {}) {
  try {
    const out = exec('claude', ['--version'], { encoding: 'utf8', timeout: 20_000 });
    return { ok: true, version: String(out).trim().slice(0, 80) };
  } catch (e) {
    return { ok: false, error: `${e.code || ''} ${e.message || ''}`.trim().slice(0, 200) };
  }
}

/** 로그·진단용 발췌(원문 보존이 목적 — 경보 본문용 정제는 slot.mjs 가 따로 한다). */
function excerpt(v, n = 600) {
  const s = v == null ? '' : String(v);
  return s.length > n ? s.slice(0, n) + `…(총 ${s.length}자)` : s;
}

/**
 * 구독 claude CLI 호출 → result 텍스트(코드펜스 제거). shorts/script.mjs 와 동일 경로.
 * 일시적 장애(claude 자체 auto-update 중 바이너리 순간 소실=ENOENT, 반쯤 설치된 상태=비정상종료,
 * 타임아웃·과부하)는 동기 백오프로 재시도한다. 2026-07-14 실측: 18:00 킥스타트 도중 claude 가
 * 재설치되며 배치 후보 #2~5 가 전멸 → callClaude 무재시도가 원인. (env CURIOSITY_CLAUDE_RETRIES)
 *
 * 실패 시(2026-07-30 추가): exit code·signal·stderr·**stdout**·시도횟수·소요시간·claude --version
 * 을 모아 분류(classifyClaudeFailure)하고, 구조화 로그 + state/shorts-curiosity/last-claude-failure.json
 * 에 남긴 뒤 `err.diag` 로 던진다 → 결방 경보가 원인을 실을 수 있다.
 * 재시도 정책은 그대로 유지하되, **확실한 한도 신호일 때만** 즉시 포기한다(무의미한 백오프 제거).
 *
 * @param {string} prompt
 * @param {object} [opt] {retries, retryBaseMs, exec, versionProbe, onFailure} — exec/versionProbe/
 *                 onFailure 는 테스트 주입점(운영 기본값은 실제 CLI 경로).
 */
export function callClaude(prompt, { retries, retryBaseMs = 4000, exec = execFileSync, versionProbe = probeClaudeVersion, onFailure = recordClaudeFailure } = {}) {
  const maxRetries = Number.isFinite(retries) ? retries
    : (Number.isFinite(parseInt(process.env.CURIOSITY_CLAUDE_RETRIES, 10)) ? parseInt(process.env.CURIOSITY_CLAUDE_RETRIES, 10) : 3);
  const startedAt = Date.now();
  let lastErr;
  let versionInfo = null;   // 실패 시 1회만 조회

  /** 실패 확정 — 진단 조립 → 구조화 로그 → 파일 기록 → err.diag 첨부해 반환. */
  const fail = (raw, { attempt, abort = null }) => {
    if (!versionInfo) versionInfo = versionProbe({ exec });
    const cls = classifyClaudeFailure({ ...raw, versionOk: versionInfo.ok });
    const diag = {
      at: new Date().toISOString(),
      source: 'curiosity/callClaude',
      kind: cls.kind,
      confidence: cls.confidence,
      evidence: cls.evidence,
      action: failureAction(cls.kind),
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
    };
    // 구조화 로그 — 원문·분류·신호를 한 줄에 담아 runs/*.log 에서 사후 추적 가능하게.
    log.error(`claude 실패 진단 [${diag.kind}/${diag.confidence}]`, diag);
    try { onFailure(diag); } catch { /* 기록 실패 비차단 */ }
    const err = new Error(`claude 실행 실패(${diag.kind}): ${raw.message || 'no message'}${diag.stderr_empty ? ' :: stderr 비어있음' : ' :: ' + excerpt(raw.stderr, 300)}`);
    err.diag = diag;
    return err;
  };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let raw;
    try {
      raw = exec('claude', ['-p', '--output-format', 'json', '--dangerously-skip-permissions'], {
        input: prompt, encoding: 'utf8', timeout: 300_000, maxBuffer: 40 * 1024 * 1024,
      });
    } catch (e) {
      lastErr = e;
      const obs = { message: e.message, stderr: e.stderr, stdout: e.stdout, status: e.status, signal: e.signal, code: e.code, killed: e.killed };
      // 확실한 한도 신호면 4s·8s·12s 백오프는 무의미(슬롯만 지연) → 즉시 포기하고 경보로 넘긴다.
      // ⚠ 'high' 확신일 때만 — 오분류로 발행이 죽지 않게 보수적으로.
      const early = classifyClaudeFailure({ ...obs, versionOk: true });
      if (early.kind === 'usage-limit' && early.confidence === 'high') {
        throw fail(obs, { attempt, abort: 'usage-limit(확실) — 재시도 생략' });
      }
      // ENOENT(바이너리 소실)·비정상종료(Command failed)·타임아웃·과부하 = 일시적 → 재시도.
      const blob = `${e.code || ''} ${e.message || ''} ${e.stderr || ''}`;
      const transient = e.code === 'ENOENT' || /ENOENT|ETXTBSY|EAGAIN|Command failed|timeout|Connection closed|mid-response|overloaded|too many requests|\b(429|500|502|503|504|529)\b/i.test(blob);
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
      const early = classifyClaudeFailure({ ...obs, versionOk: true });
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
}

/** 텍스트에서 첫 JSON(객체/배열) 추출·파싱. */
export function extractJson(text) {
  const m = text.match(/[[{][\s\S]*[\]}]/);
  return JSON.parse(m ? m[0] : text);
}

/**
 * 에이전트 정의(.claude/agents/<name>.md)의 <!-- BRIEF:start -->…<!-- BRIEF:end -->
 * 페르소나 프리앰블을 로드한다. 이 페르소나가 claude -p 프롬프트 선두에 붙어 실제 출력을
 * 좌우 → 에이전트 정의가 장식이 아닌 "진짜 두뇌". md 없거나 블록 없으면 빈 문자열(폴백).
 */
export function loadAgentBrief(name) {
  try {
    const p = join(REPO_ROOT, '.claude', 'agents', `${name}.md`);
    const m = readFileSync(p, 'utf8').match(/<!--\s*BRIEF:start\s*-->([\s\S]*?)<!--\s*BRIEF:end\s*-->/);
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

/** 심링크 견고 main-module 판별. */
export function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try { return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]); }
  catch { return fileURLToPath(metaUrl) === resolve(process.argv[1]); }
}
