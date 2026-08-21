/**
 * shorts-curiosity/lib.mjs — 독립 "설마 진짜?" 호기심 쇼츠 채널 공용 유틸
 *
 * 주제 백로그(경량 JSONL) + produced 인덱스 + 설정 + 구독 claude 호출 헬퍼.
 * 제작(대본→이미지→더빙→영상)은 scripts/shorts/ 엔진을 재사용한다(여긴 소재·선정·검증 레이어).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { paths } from '../lib/config.mjs';
import { makeLogger } from '../lib/log.mjs';
// 대기 폴더 경로의 진실은 shorts/lib.mjs 하나뿐이다 — 여기서 재정의하면 갈라진다.
import { pendingDir } from '../shorts/lib.mjs';

import { makeClaudeRunner, probeClaudeVersion } from '../lib/claude-runner.mjs';
import { makeLifecycle } from '../kernel/lifecycle.mjs';
import {
  FAILURE_KINDS, FAILURE_LABELS, classifyFailure, failureAction as kernelFailureAction,
} from '../kernel/llm-failure.mjs';

// 실패 분류의 정본은 kernel/llm-failure.mjs 하나다. 여기서는 채널 고유 문구만 얹는다.
export { FAILURE_KINDS, FAILURE_LABELS };
export const classifyClaudeFailure = classifyFailure;

/** 갈래별 사람 조치 문구 — 호기심 채널의 폴백·로그 경로를 주입한다. */
export function failureAction(kind) {
  return kernelFailureAction(kind, {
    fallbackNote:  '그 사이 발행은 재고 폴백이 담당한다.',
    unknownAction: '원인 불명 — 진단 로그 확인 필요: runs/curiosity-slot-<날짜>.log 와 state/shorts-curiosity/last-claude-failure.json',
  });
}
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
/**
 * 이 채널의 수명주기. 상상이 아니라 **호출부 전수와 인덱스 실측**에서 뽑았다
 * (2026-08-21: 인덱스 133건 = uploaded 112 · held 15 · retired 3 · produced 3,
 *  markStatus 호출 12곳 = held 7 · uploaded 3 · produced 2).
 *
 * `retired` 는 지금 어떤 코드도 쓰지 않는다 — 인덱스에 남은 레거시라 상태 집합에는
 * 두되 간선은 종단으로 잡는다(읽기 호환).
 */
export const STATES = Object.freeze(['produced', 'uploaded', 'held', 'retired']);

export const TRANSITIONS = Object.freeze({
  null:     ['produced', 'held'],            // 첫 판정 — 제작 성공이거나 보류
  held:     ['held', 'produced', 'retired'], // 보류분은 다음 슬롯에 재시도된다
  produced: ['uploaded', 'held', 'retired'], // 제작 완료 → 업로드, 실패하면 보류
  uploaded: [],                              // 종단
  retired:  [],                              // 종단(레거시)
});

const LIFECYCLE = makeLifecycle({ states: STATES, transitions: TRANSITIONS, terminal: ['uploaded', 'retired'] });

/**
 * 🔴 지금은 **shadow 모드**다 — 불법 전이를 기록만 하고 막지 않는다.
 *
 * 이 채널은 하루 2편을 실제로 발행 중이고, 위 전이표는 코드에서 도출한 것이라
 * 아직 관측으로 검증되지 않았다. 지금 throw 로 바꾸면 표에 없는 정상 전이 하나가
 * 발행을 세운다. 그래서 cardnews 가 이미 쓰는 방식(source-fidelity 의 shadow)과 같이
 * 위반을 쌓고, 며칠 뒤 위반 0 이 확인되면 그때 enforce 로 올린다.
 *
 * 올리는 법: `CURIOSITY_LIFECYCLE_ENFORCE=1` (또는 이 함수의 shadow 분기 제거).
 */
export function lifecycleViolationsPath() {
  return join(paths.state, 'shorts-curiosity', 'lifecycle-violations.jsonl');
}

function recordLifecycleViolation(rec) {
  try {
    mkdirSync(dirname(lifecycleViolationsPath()), { recursive: true });
    appendFileSync(lifecycleViolationsPath(), JSON.stringify(rec) + '\n', 'utf8');
  } catch { /* 기록 실패가 발행을 막으면 안 된다 */ }
}

export function markStatus(id, status, extra = {}) {
  const idx = loadIndex();
  const from = idx[id]?.status ?? null;

  const verdict = LIFECYCLE.canTransition(from, status);
  if (!verdict.ok) {
    const rec = { at: new Date().toISOString(), id, from, to: status, reason: verdict.reason };
    if (process.env.CURIOSITY_LIFECYCLE_ENFORCE === '1') {
      throw new Error(`수명주기 위반: ${verdict.reason} (id=${id})`);
    }
    log.warn(`수명주기 위반(shadow — 막지 않음): ${verdict.reason} (id=${id})`);
    recordLifecycleViolation(rec);
  }

  idx[id] = { ...(idx[id] || {}), status, at: new Date().toISOString(), ...extra };
  saveIndex(idx);
  if (status === 'uploaded') releaseUploadedVideo(idx[id]);
  return idx[id];
}

/**
 * 업로드가 확정된 mp4 를 대기 폴더에서 지운다.
 *
 * 왜 필요한가: 업로드 자체는 정상인데 원본을 아무도 안 지워 `state/shorts-queue/pending/` 에
 * 계속 쌓였다(2026-08-19 실측: 111개 · 1.8GB · 7월 13일부터). 하루 2~3편 × 평균 16MB 라
 * **한 달에 약 1GB씩** 무한히 는다. 영상은 이미 유튜브에 있으므로 로컬 원본은 중복이다.
 *
 * ⚠ 삭제 조건을 좁게 잡는다 — 되돌릴 수 없다.
 *    youtube_id 와 uploaded_at 이 **둘 다** 있어야 지운다. 하나라도 없으면 업로드가 끝났다는
 *    증거가 부족하므로 파일을 남긴다(다음 실행에서 다시 판단할 수 있다).
 * ⚠ 경로도 확인한다. 대기 폴더(`shorts-queue/pending`) 안의 파일만 지운다 — 인덱스의 video 가
 *    다른 위치를 가리키면(수동 이동·아카이브) 건드리지 않는다.
 * ⚠ 실패해도 업로드 흐름을 멈추지 않는다. 정리는 부수 작업이지 본 작업이 아니다.
 */
export function releaseUploadedVideo(entry) {
  try {
    if (!entry || !entry.youtube_id || !entry.uploaded_at || !entry.video) return false;
    const file = resolve(entry.video);
    const dir = resolve(pendingDir());
    if (!file.startsWith(dir + sep)) return false;   // 대기 폴더 밖은 대상 아님
    if (!existsSync(file)) return false;
    unlinkSync(file);
    return true;
  } catch {
    return false;   // 정리 실패가 업로드 성공을 되돌리면 안 된다
  }
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


// ─── claude 실패 진단 (2026-07-30 신설) ──────────────────────────────────────
//
// 왜: 2026-07-25·26 에 6개 슬롯이 전멸(하루 3편 → 0편 × 2일)했는데 남은 증거가
// `claude 실행 실패: Command failed: claude -p …` 한 줄뿐이었다. **stderr 가 비어 있어서**
// 한도 소진인지·CLI 손상인지·네트워크인지 32시간이 지난 지금도 모른다.
// execFileSync 는 exit code(status)·signal·**stdout** 도 주는데 그걸 안 봤다.
// `--output-format json` 이므로 오류는 stderr 가 아니라 **stdout JSON** 으로 나올 가능성이 크다.


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
// 정본은 lib/main-module.mjs 한 곳이다. 기존 소비자를 위해 여기서 재export 한다.
export { isMainModule } from '../lib/main-module.mjs';

// ─── claude 호출 (파일 끝) ──────────────────────────────────────────────────
// ⚠ 팩토리 호출이 **모듈 평가 시점에 실행**되므로, 정책으로 넘기는 값(log·
//   failureAction·FAILURE_LABELS·chargeClaudeCall …)이 모두 초기화된 뒤여야 한다.
//   위쪽에 두면 const 의 TDZ 에 걸려 모듈이 통째로 죽는다(2026-08-21 실측).
// claude 호출의 정본은 lib/claude-runner.mjs 하나다(이 파일에 있던 포크를 그리로 올렸다).
// 여기서는 채널 정책 — 진단 출처 이름과 재시도 환경변수 — 만 얹는다.
export { probeClaudeVersion };
export const callClaude = makeClaudeRunner({
  source:        'curiosity/callClaude',
  retriesEnvVar: 'CURIOSITY_CLAUDE_RETRIES',
  actionFor:     failureAction,
  recordFailure: (diag) => recordClaudeFailure(diag),
  log,
});
