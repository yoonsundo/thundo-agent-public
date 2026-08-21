/**
 * cardnews/lib.mjs — 인스타 카드뉴스 채널 공용 유틸 (US-001 골격 + US-004 상태 I/O)
 *
 * 설정 로더 · 경로 헬퍼 · 해시 · 멱등 마커 · **상태 I/O(index/flush/transition/appendRun)**.
 * claude 호출(callClaude/loadAgentBrief)은 Step 5 소관이라 아직 여기 없다.
 *
 * ⚠ **모든 상태 경로는 `state/cardnews/` 한 뿌리 아래**에 둔다(계획 §3.0). 이 채널은
 * 포스트당 JPEG 7장을 만들어 `work/` 가 빠르게 부푸는데, `.gitignore` 의
 * `state/cardnews-*` 같은 글롭은 `state/cardnews/` 를 **매칭하지 못한다**. 선례:
 * state/shorts-footage 미차단 → mp4 136개(1.9GB) 가 커밋에 섞여 push 가 9일 거부됨.
 * 루트를 하나로 고정해 두면 무시 규칙 4줄이 작업물 전체를 확실히 덮는다.
 *
 * 테스트 격리: CARDNEWS_CONFIG_OVERRIDE(설정) · STATE_DIR_OVERRIDE(상태 루트).
 */
import { readFileSync, writeFileSync, appendFileSync, renameSync, mkdirSync, existsSync,  } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { paths } from '../lib/config.mjs';
import { makeLogger } from '../lib/log.mjs';

import { makeClaudeRunner, probeClaudeVersion } from '../lib/claude-runner.mjs';
import { makeLifecycle } from '../kernel/lifecycle.mjs';
import {
  FAILURE_KINDS, classifyFailure, failureAction as kernelFailureAction,
} from '../kernel/llm-failure.mjs';

// 실패 분류의 정본은 kernel/llm-failure.mjs 하나다(이 파일에 있던 포크를 그리로 올렸다).
export { FAILURE_KINDS, classifyFailure };

/** 갈래별 사람 조치 문구 — 카드뉴스 채널의 폴백·로그 경로를 주입한다. */
export function failureAction(kind) {
  return kernelFailureAction(kind, {
    fallbackNote:  '그 사이 발행은 예비 대본 buffer 가 담당한다.',
    unknownAction: '원인 불명 — 진단 로그 확인 필요: runs/cardnews-<날짜>.log 와 state/cardnews/last-claude-failure.json',
  });
}
const log = makeLogger('cardnews/lib');

const __dir = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dir, '../../');

// ── 설정 ─────────────────────────────────────────────────────────────────────

export function configPath() {
  return process.env.CARDNEWS_CONFIG_OVERRIDE || join(REPO_ROOT, 'config', 'cardnews.json');
}

/** config/cardnews.json 로드. 필수 섹션이 없으면 throw(설정 오타를 조용히 넘기지 않는다). */
export function loadConfig() {
  const cfg = JSON.parse(readFileSync(configPath(), 'utf8'));
  for (const k of ['channel', 'meta', 'cards']) {
    if (!cfg[k]) throw new Error(`cardnews.json: ${k} 필수`);
  }
  return cfg;
}

// ── 경로 (전부 state/cardnews/ 하위) ─────────────────────────────────────────

export function stateRoot() { return join(paths.state, 'cardnews'); }

export function indexPath()       { return join(stateRoot(), 'index.json'); }
export function runsPath()        { return join(stateRoot(), 'runs.jsonl'); }
/** 채점 분포 로그 — runs.jsonl 의 형제. 런 결과가 아니라 **선정 과정**의 관측치라 파일을 나눈다. */
export function pickScoresPath()  { return join(stateRoot(), 'pick-scores.jsonl'); }
export function backlogDir()      { return join(stateRoot(), 'backlog'); }
export function backlogPath()     { return join(backlogDir(), 'backlog.jsonl'); }
export function bufferDir()       { return join(stateRoot(), 'buffer'); }
export function alertsDir()       { return join(stateRoot(), 'alerts'); }
export function reviewQueuePath() { return join(stateRoot(), 'review-queue.jsonl'); }

/**
 * 작업공간. ⛔ git 추적 금지 경로.
 * 계획서가 두 형태를 쓴다 — attemptId 없으면 포스트 루트(§3.6 `script.json`),
 * 있으면 시도별 하위(§3.9 `slide-NN.jpg` 7장). 재시도마다 슬라이드는 갈리지만
 * 대본은 갈리지 않으므로 깊이가 다르다.
 */
export function workDir(postId, attemptId) {
  const base = join(stateRoot(), 'work', postId);
  return attemptId ? join(base, attemptId) : base;
}

/** ~ 를 홈으로 확장(크리덴셜 경로용). */
export function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~') ? join(homedir(), p.slice(1).replace(/^[/\\]/, '')) : p;
}

// ── 백로그 JSONL I/O (§3.2) ──────────────────────────────────────────────────

/**
 * 백로그 전체 로드 → BacklogItem[]. **깨진 줄은 무시**한다(`loadRuns` 와 같은 정책) —
 * 한 줄이 상했다고 40건짜리 소재 재고 전체를 포기하면 그날이 결방이 된다. 인덱스와 달리
 * 백로그 손상은 중복 발행으로 이어지지 않으므로 관대해도 안전하다.
 */
export function loadBacklog() {
  const p = backlogPath();
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

export function appendBacklog(items) {
  mkdirSync(backlogDir(), { recursive: true });
  for (const it of items) appendFileSync(backlogPath(), JSON.stringify(it) + '\n', 'utf8');
  return items.length;
}

// ── 해시 · 마커 ──────────────────────────────────────────────────────────────

export function sha256(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * 캡션 정규화 — NFC + 공백 collapse.
 * 우리가 보낸 캡션과 Meta 가 돌려주는 캡션은 개행·공백이 달라질 수 있어, 해시 매칭 전에
 * 양쪽을 같은 모양으로 만든다(M1 폴백 매칭 키의 전제).
 */
export function normalizeCaption(s) {
  return String(s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

/**
 * 멱등 마커 — 캡션 최말미에 박아 두고, 발행 결과가 불확실할 때(publish_unknown) 이 문자열로
 * "이미 올라간 게시물"을 찾아낸다. 하이픈을 제거하는 이유는 인스타 해시태그가 하이픈에서
 * 끊기기 때문. `cn-2026-08-01-a1b2c3d4` → `#cn20260801a1b2c3d4`.
 *
 * ⚠ 계획 §3.2 의 식 `'#cn' + postId.replace(/-/g,'')` 은 post_id 가 이미 `cn-` 으로 시작해
 * `#cncn…` 을 만든다. 계획이 §3.2·§5.1 두 곳에서 못박은 **결과값**(`#cn20260801a1b2c3d4`)을
 * 정본으로 삼고 식을 고쳤다. `cn` 네임스페이스는 어떤 입력에서도 정확히 한 번만 붙는다.
 */
export function idemMarker(postId) {
  const flat = String(postId).replace(/-/g, '');
  return '#' + (flat.startsWith('cn') ? flat : `cn${flat}`);
}

/** KST 기준 `YYYY-MM-DD`. post_id·runs.jsonl·슬롯 판정이 전부 이 하루 경계를 쓴다. */
export function kstDate(now = new Date()) {
  return new Date(now).toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}

/**
 * 결정론적 post_id — `cn-{KST YYYY-MM-DD}-{backlog id 10자}`(계획 §5.1).
 * 같은 날 같은 백로그 아이템을 재실행하면 같은 id 가 나와 **이어받기**가 되고, 날이 바뀌면
 * 다른 id 가 나와 **새 시도**가 된다(§5.2 "held 는 같은 post_id 로 되살아나지 않는다").
 *
 * 🔴 날짜 자리는 형식 계약이다 — `host.mjs:objectPath` 가 `^cn-(\d{4})-(\d{2})-(\d{2})-` 로
 * 날짜를 **되파싱해** 스토리지 경로를 만든다. 자리 수·구분자를 바꾸면 content-addressed
 * 경로가 "지금" 기준으로 흘러 슬롯 재사용 판정이 영구 false 가 된다.
 */
export function postIdFor(backlogId, now = new Date()) {
  const id = String(backlogId ?? '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  if (!id) throw new Error('postIdFor: backlogId 필수(영숫자 0자)');
  return `cn-${kstDate(now)}-${id.slice(0, 10)}`;
}

// ── 상태 머신 — 전이표 (계획 §5.2) ───────────────────────────────────────────

/** 9-state. `null` 은 "아직 post 가 없음"을 뜻하는 의사 상태다(인덱스에 저장되지 않는다). */
export const STATES = Object.freeze([
  'planned', 'scripted', 'rendered', 'hosted', 'child_containers_partial',
  'carousel_container_created', 'publish_unknown', 'published', 'held',
]);

/**
 * 허용 전이. **여기 없는 간선은 throw** 다. self 전이(같은 상태로의 transition)가
 * 허용된 3개 상태 외에는 없다는 점이 중요하다 — 나머지 상태에서 필드만 남기려면
 * `flush()` 를 써야 한다. 이 표는 write-ahead 를 모른다(알아서도 안 된다).
 */
export const TRANSITIONS = Object.freeze({
  null: ['planned'],
  planned: ['scripted', 'held'],
  scripted: ['rendered', 'held'],
  rendered: ['hosted', 'held'],
  hosted: ['child_containers_partial', 'held'],
  child_containers_partial: ['child_containers_partial', 'carousel_container_created', 'held'],
  carousel_container_created: ['carousel_container_created', 'publish_unknown', 'child_containers_partial', 'held'],
  publish_unknown: ['publish_unknown', 'published', 'held'],
  held: ['hosted'],            // 🔴 held_class==='transient' + verifyStored 통과일 때만(§3.14.3)
  published: [],               // 종단 — 어떤 간선도 없다
});


// 상태 집합·간선은 이 채널의 도메인 지식이라 여기 남는다. **판정 로직만** 커널로 옮겼다
// (kernel/lifecycle.mjs) — 세 버티컬이 같은 개념을 서로 다른 방식으로 검증하던 것을 없앤다.
const LIFECYCLE = makeLifecycle({ states: STATES, transitions: TRANSITIONS, terminal: ['published'] });

export function allowedTransitions(from) {
  return LIFECYCLE.allowedTransitions(from);
}

/** 전이 가능 여부(불허면 사유 포함). `transition` 이 이걸로 판정한다. */
export function canTransition(from, to) {
  return LIFECYCLE.canTransition(from, to);
}

// ── 인덱스 I/O ───────────────────────────────────────────────────────────────

/**
 * index.json 로드. 파일 부재는 `{}`(첫 런), **파싱 실패는 throw** 다.
 * 깨진 인덱스를 `{}` 로 삼키면 이미 발행한 포스트를 "미발행"으로 보고 다시 쏜다 —
 * 이 채널에서 가장 비싼 실패(중복 게시)라, 조용히 넘기지 않고 런을 세운다.
 */
export function loadIndex() {
  const p = indexPath();
  if (!existsSync(p)) return {};
  const raw = readFileSync(p, 'utf8');
  let idx;
  try { idx = JSON.parse(raw); }
  catch (e) { throw new Error(`index.json 파싱 실패(${p}): ${e.message} — 손상 인덱스로 진행하면 중복 발행 위험`); }
  return idx && typeof idx === 'object' ? idx : {};
}

/**
 * 원자적 저장 — tmp 쓰기 → `renameSync`(같은 디렉터리 = 같은 파일시스템 = 원자적 교체).
 * 쓰기 도중 프로세스가 죽어도 기존 `index.json` 은 손대지 않은 상태로 남고, 잔여물은
 * `.tmp` 하나뿐이다(§7.3 시나리오 13 · ADR-2). tmp 이름에 pid 를 넣어 동시 실행이
 * 서로의 tmp 를 덮지 않게 한다(다중 프로세스 자체는 `flock -n` 소관).
 */
export function saveIndexAtomic(idx) {
  const p = indexPath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(idx, null, 2) + '\n', 'utf8');
  renameSync(tmp, p);
  return p;
}

export function getPost(postId) {
  return loadIndex()[postId] || null;
}

export function putPost(post) {
  if (!post || !post.post_id) throw new Error('putPost: post_id 필수');
  const idx = loadIndex();
  idx[post.post_id] = post;
  saveIndexAtomic(idx);
  return post;
}

/**
 * §5.1 스키마 골격. AC-13 필수 필드를 **키로 존재**하게 만들어 두면, 이후 단계가
 * `'field' in post` 로 안전하게 물어볼 수 있고 부분 기록이 undefined 로 사라지지 않는다.
 */
function newPost(postId, now) {
  return {
    post_id: postId,
    backlog_id: null,
    status: null,
    attempt_id: 'att-1',
    attempt_started_at: now.toISOString(),
    revived_at: null,

    subject: null, country: null, domain: null, from_buffer: false,

    caption: null, caption_sha256: null, idem_marker: idemMarker(postId), hashtag_count: null,

    slide_files: [], slide_sha256: [], public_url: [], hosted_at: null,

    child_container_ids: [], child_created_at: [],
    carousel_container_id: null, carousel_created_at: null, carousel_children_key: null,

    publish_requested_at: null, reconcile_after: null,
    publish_issued_count: 0, publish_confirmed_failed_count: 0,
    published_media_id: null, published_at: null, reconciled: false,

    liveness: null, liveness_note: null, permalink: null,

    held_reason: null, held_class: null, held_diag: null,

    provenance: null,
    tier2_warnings: [], reviewed_at: null,

    history: [],
  };
}

/**
 * **write-ahead 영속화 — 상태는 건드리지 않는다.** 전이표 검사를 하지 않는 것이 이 함수의
 * 존재 이유다(ADR-2). 되돌릴 수 없는 외부 호출(자식 컨테이너·캐러셀·mediaPublish) 직전에
 * 그 사실을 먼저 디스크에 남기는 용도라, 상태는 그대로인 채 필드만 바뀐다.
 *
 * `transition(x, 같은상태)` 를 쓰고 싶어지면 그건 flush 다 — 예전 개정판이 이 둘을 한
 * 함수로 묶는 바람에 resume 진입이 전부 불허 간선에 걸려 죽었다.
 */
export function flush(postId, patch = {}, { now = new Date() } = {}) {
  const idx = loadIndex();
  const post = idx[postId];
  if (!post) throw new Error(`flush: 인덱스에 없는 post_id '${postId}'`);
  if ('status' in patch) throw new Error('flush: status 는 바꿀 수 없다 — transition() 을 쓰라');

  const keys = Object.keys(patch);
  Object.assign(post, patch);
  post.history = [...(post.history || []), {
    at: now.toISOString(), kind: 'flush', keys, attempt_id: post.attempt_id ?? null,
  }];
  idx[postId] = post;
  saveIndexAtomic(idx);
  return post;
}

/**
 * **상태 전이 + 필드.** 전이표(§5.2)를 강제하고, 불허 간선이면 throw 한다.
 * `to==='held'` 면 `held_reason` 을 필수로 요구하고 `held_class`·`held_diag` 를 반드시
 * 채운다 — "분류되지 않은 held" 를 만들 방법 자체를 없애는 것이 스펙 1-B 요건이다.
 */
export function transition(postId, to, patch = {}, { now = new Date() } = {}) {
  const idx = loadIndex();
  const prev = idx[postId] || null;
  const from = prev ? (prev.status ?? null) : null;

  const verdict = canTransition(from, to);
  if (!verdict.ok) throw new Error(`transition(${postId}): ${verdict.reason}`);

  const post = prev || newPost(postId, now);
  Object.assign(post, patch);
  post.status = to;

  if (to === 'held') {
    const reason = patch.held_reason ?? prev?.held_reason ?? null;
    if (!reason) throw new Error(`transition(${postId} → held): held_reason 필수 — 분류 없는 held 는 만들 수 없다`);
    post.held_reason = reason;
    post.held_diag = 'held_diag' in patch ? (patch.held_diag ?? null) : (prev?.held_diag ?? null);
    post.held_class = patch.held_class || classifyHeld(reason, post.held_diag);
  }

  post.history = [...(post.history || []), {
    at: now.toISOString(), from, to, attempt_id: post.attempt_id ?? null,
  }];
  idx[postId] = post;
  saveIndexAtomic(idx);
  return post;
}

// ── 실패 분류 ────────────────────────────────────────────────────────────────


export const HELD_CLASSES = Object.freeze(['transient', 'permanent', 'external']);

/**
 * held 사유 → 회복 갈래(§3.2 · §6.1). **`external` 만 스펙 1-A(30일 무인) 집계에서 빠진다**
 * — 우리가 못한 게 아니라 밖에서 막힌 날이라는 뜻이라, 여기 잘못 넣으면 성공 기준이
 * 스스로를 면제한다. 그래서 external 은 화이트리스트로만 들어간다(기본값 아님).
 *
 *  transient = 다음 슬롯·`sweepUnresolved`(24h)가 그대로 재시도하면 풀릴 수 있는 것
 *  permanent = 재시도해도 같은 결과 — 익일 새 post_id 로 다른 소재(§6.1)
 *  external  = 사람 재인증·플랫폼 조치·예산 등 파이프라인 밖 강제
 *
 * @param {string} reason `held_reason`(§5.1 어휘, `<영역>:<사유>`)
 * @param {object|null} diag `classifyFailure` 판정(사유가 claude 장애일 때 갈래를 좁힌다)
 */
export function classifyHeld(reason, diag = null) {
  const r = String(reason || '').toLowerCase();
  const area = r.includes(':') ? r.slice(0, r.indexOf(':')) : r;

  // ① 밖에서 막힌 것 — 화이트리스트(정확 일치 우선).
  if (r.startsWith('meta:token-expired') || r.startsWith('meta:permission') || r.startsWith('meta:oauth')) return 'external';
  if (['readiness', 'limit', 'quota', 'token', 'budget', 'takedown'].includes(area)) return 'external';

  // ②-0 게이트 중 **확인 불가**만은 예외다.
  //
  // 🔴 인용 게이트는 원문을 받아 구절 실재를 대조한다. 여기서 두 실패는 성격이 정반대다:
  //   `gate:quote:blocked`     = 그 책에 그 구절이 없다 → **가짜 인용**. 재시도해도 없다. permanent.
  //   `gate:quote:unavailable` = 원문을 못 받았다(네트워크·캐시 부재) → **판정 자체를 못 했다**.
  //                              재시도하면 풀린다. 이걸 permanent 로 두면 네트워크가 한 번
  //                              흔들린 날 멀쩡한 소재가 영구 폐기된다.
  // 접두가 둘 다 `gate:` 라 아래 ②가 뭉뚱그려 permanent 로 보내므로, 그 앞에서 갈라낸다.
  if (r.startsWith('gate:quote:unavailable')) return 'transient';

  // ② 재시도가 무의미한 것.
  if (['gate', 'factcheck', 'reconcile', 'publish'].includes(area)) return 'permanent';
  if (r === 'held:permanent' || r === 'held:artifacts-gone') return 'permanent';

  // ③ 그대로 재시도하면 풀릴 수 있는 것.
  if (['meta', 'host', 'child', 'container', 'render'].includes(area)) return 'transient';

  // ④ 사유만으로 모르면 claude 판정으로 좁힌다.
  if (diag && diag.kind) {
    if (diag.kind === 'usage-limit' || diag.kind === 'auth') return 'external';
    if (['network', 'timeout', 'cli-missing'].includes(diag.kind)) return 'transient';
  }
  // ⑤ 그래도 모르면 transient. **모르는 것을 external 로 두지 않는다** — 그러면 1-A 가
  //    스스로를 면제한다. transient 는 sweep 이 산출물 검증을 거쳐 재시도할 뿐이라 안전하다.
  return 'transient';
}

// ── 런 기록 — runs.jsonl (§3.21) ─────────────────────────────────────────────

// `skipped-cap` = 오늘 이미 상한만큼 냈다(정상 스킵). 열거에 없으면 `error` 로 clamp 되어
// 멀쩡한 두 번째 슬롯이 1-B 의 "실패일"로 집계된다 — 가용성 지표가 스스로 오염된다.
export const RUN_OUTCOMES = Object.freeze(['published', 'no-pick', 'held', 'halt', 'skipped-disabled', 'skipped-cap', 'error']);
export const FAILURE_STAGES = Object.freeze([
  'backlog', 'pick', 'factcheck', 'script', 'gate', 'render', 'host', 'publish', 'token', 'budget',
]);

/**
 * 런 1건 append — **post 단위가 아니라 런 단위다.** 이게 요점이다:
 * `postIdFor()` 는 claude 의존 단계(backlog·pick·factcheck·script) **뒤에** 불린다. 그 앞이
 * 죽으면 post 가 아예 생기지 않아 인덱스엔 아무 흔적도 남지 않는다(07-25/26 이 정확히 그것).
 * 그래서 이 함수는 **post 가 하나도 없어도 쓸 수 있어야** 하고, 종료 경로와 무관하게 1줄 남긴다.
 *
 * 기록 실패가 런을 죽이지 않는다(베스트에포트) — 다만 조용히 넘기지 않고 warn 을 남긴다.
 */
export function appendRun(record = {}) {
  const now = record.now instanceof Date ? record.now : new Date();
  let outcome = record.outcome;
  if (!RUN_OUTCOMES.includes(outcome)) {
    log.warn(`appendRun: 미지의 outcome '${outcome}' → 'error' 로 기록`);
    outcome = 'error';
  }
  const row = {
    date: record.date || kstDate(now),
    slot: record.slot ?? null,
    started_at: record.started_at ?? null,
    ended_at: record.ended_at ?? now.toISOString(),
    outcome,
    post_id: record.post_id ?? null,
    failure_class: record.failure_class ?? null,
    failure_stage: record.failure_stage ?? null,
    diag: record.diag ?? null,
    via: record.via ?? null,
    // ── 이중 생성(2026-07-31) ─────────────────────────────────────────────────
    // ⚠ 이 row 는 **명시 화이트리스트**다 — 호출자가 넘긴 나머지 키는 조용히 버려진다.
    // 그 설계 자체는 옳지만(runs.jsonl 스키마가 마음대로 부풀지 않는다), 새 필드를 여기
    // 추가하지 않으면 호출부만 고치고 "기록했다"고 착각하게 된다.
    //
    //  generator            = 그날 그 슬롯에 **배정된** 작가
    //  generator_fallback   = 코덱스가 죽어 클로드가 대신 쓴 내역(없으면 null)
    //                         → 배정과 실집필이 갈린 날을 이걸로만 구분할 수 있다
    //  codex_calls          = 코덱스 호출수. 클로드 예산 원장과 분리돼 있으므로 여기 없으면
    //                         사용량 분산이 실제로 일어났는지 사후에 알 방법이 없다
    generator: record.generator ?? null,
    generator_fallback: record.generator_fallback ?? null,
    codex_calls: record.codex_calls ?? 0,
  };
  try {
    mkdirSync(stateRoot(), { recursive: true });
    appendFileSync(runsPath(), JSON.stringify(row) + '\n', 'utf8');
  } catch (e) {
    log.warn(`runs.jsonl 기록 실패(비차단): ${e.message}`);
  }
  return row;
}

/** runs.jsonl 전체 로드(깨진 줄 무시 — 한 줄이 상해도 30일 집계를 포기하지 않는다). */
export function loadRuns() {
  const p = runsPath();
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// ── claude 호출 (§3.2 · Step 5) ──────────────────────────────────────────────
//
// `shorts-curiosity/lib.mjs:229-314` 포크. **원본은 한 줄도 손대지 않는다**(Tier A diff 0줄) —
// 이 채널의 요구(런당 호출 예산·자체 진단 경로·cardnews classifyFailure 재사용)가 원본과 달라
// 파라미터화보다 포크가 싸고, 원본을 건드리면 매일 도는 쇼츠 채널을 위험에 빠뜨린다.
//
// 포크하면서 바꾼 것은 셋뿐이다:
//  ① 실패 분류를 **이 파일의 `classifyFailure`** 로 보낸다(분류기를 두 개 두지 않는다).
//  ② 런당 호출 카운터 — `budget.max_claude_calls_per_run` 초과 시 throw.
//  ③ 진단 파일 경로가 `state/cardnews/last-claude-failure.json`.

/** 사람이 읽는 갈래 라벨(경보 본문용). */
export const FAILURE_LABELS = Object.freeze({
  'usage-limit': '구독 사용량 한도 소진',
  auth: '인증 만료·로그인 필요',
  'cli-missing': 'claude CLI 실행 불가(부재·손상)',
  timeout: '응답 시간 초과',
  network: '네트워크·API 연결 실패',
  unknown: '원인 불명',
});


export function claudeFailurePath() {
  return join(stateRoot(), 'last-claude-failure.json');
}

/** 진단 기록(베스트에포트 — 기록 실패가 런을 죽이지 않는다). */
export function recordClaudeFailure(diag) {
  try {
    mkdirSync(dirname(claudeFailurePath()), { recursive: true });
    writeFileSync(claudeFailurePath(), JSON.stringify(diag, null, 2) + '\n', 'utf8');
  } catch (e) {
    log.warn(`claude 실패 진단 기록 실패(비차단): ${e.message}`);
  }
  return diag;
}


// ── 런당 호출 예산 ───────────────────────────────────────────────────────────
//
// 프로세스 = 런이다(슬롯 cron 이 프로세스를 새로 띄운다). 모듈 스코프 카운터면 충분하고,
// 상태 파일로 만들면 실패한 런의 잔여 카운트가 다음 런을 굶긴다.

let claudeCalls = 0;

export function claudeCallCount() { return claudeCalls; }
export function resetClaudeCalls() { claudeCalls = 0; return 0; }

/**
 * 호출 1건 계상. **`exempt` 여도 계상은 한다** — 계상을 건너뛰면 공유 원장에 과소보고되어
 * 예산이 있으나 마나 해진다(계획 F4). exempt 는 *throw 면제*일 뿐이다. buffer top-up 이
 * 유일한 exempt 사용처인 이유: top-up 은 **발행 성공 뒤**에 돌기 때문에, 여기서 throw 하면
 * 이미 나간 그날이 실패로 기록되고 결방 경보가 오발한다.
 */
export function chargeClaudeCall({ exempt = false, cfg = null, max = null } = {}) {
  claudeCalls += 1;
  const cap = Number.isFinite(max) ? max
    : (Number.isFinite(cfg?.budget?.max_claude_calls_per_run) ? cfg.budget.max_claude_calls_per_run : 9);
  if (!exempt && claudeCalls > cap) {
    const err = new Error(`budget: 런당 claude 호출 상한 초과(${claudeCalls}/${cap})`);
    err.budget = { calls: claudeCalls, cap };
    throw err;
  }
  return claudeCalls;
}


/** 텍스트에서 첫 JSON(객체/배열) 추출·파싱. */
export function extractJson(text) {
  const m = String(text ?? '').match(/[[{][\s\S]*[\]}]/);
  return JSON.parse(m ? m[0] : text);
}

/**
 * 에이전트 정의(.claude/agents/<name>.md)의 `<!-- BRIEF:start -->…<!-- BRIEF:end -->`
 * 페르소나 프리앰블을 로드한다. 이 페르소나가 `claude -p` 프롬프트 **선두**에 붙어 실제
 * 출력을 좌우한다 → 에이전트 정의가 장식이 아니라 "진짜 두뇌"(AC-17). 특히 카드뉴스는
 * 가드레일 문구("우열 비교·일반화·비하 금지, 사실 기술만")가 BRIEF 안에 살아 있어야
 * 공개 브랜드 계정이 고정관념 콘텐츠를 내지 않는다.
 *
 * md 가 없거나 블록이 없으면 빈 문자열(폴백) — 호출자는 빈 문자열이면 프리앰블 없이 진행한다.
 */
export function loadAgentBrief(name) {
  try {
    const p = join(REPO_ROOT, '.claude', 'agents', `${name}.md`);
    const m = readFileSync(p, 'utf8').match(/<!--\s*BRIEF:start\s*-->([\s\S]*?)<!--\s*BRIEF:end\s*-->/);
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

/** 페르소나를 프롬프트 선두에 붙인다 — 네 단계가 같은 방식으로 쓰도록 한 곳에 둔다. */
export function withBrief(name, prompt) {
  const persona = loadAgentBrief(name);
  return persona ? `${persona}\n\n${prompt}` : prompt;
}

// ── 기타 ─────────────────────────────────────────────────────────────────────

/** 심링크 견고 main-module 판별. */
// 정본은 lib/main-module.mjs 한 곳이다. 기존 소비자를 위해 여기서 재export 한다.
export { isMainModule } from '../lib/main-module.mjs';

// ─── claude 호출 (파일 끝) ──────────────────────────────────────────────────
// ⚠ 팩토리 호출이 **모듈 평가 시점에 실행**되므로, 정책으로 넘기는 값(log·
//   failureAction·FAILURE_LABELS·chargeClaudeCall …)이 모두 초기화된 뒤여야 한다.
//   위쪽에 두면 const 의 TDZ 에 걸려 모듈이 통째로 죽는다(2026-08-21 실측).
// claude 호출의 정본은 lib/claude-runner.mjs 하나다. 카드뉴스만의 정책은 둘 —
// 호출 전 예산 차감(상한을 넘기면 CLI 를 띄우지 않는다)과, 진단에 남기는 라벨·사용량.
export { probeClaudeVersion };
export const callClaude = makeClaudeRunner({
  source:        'cardnews/callClaude',
  retriesEnvVar: 'CARDNEWS_CLAUDE_RETRIES',
  actionFor:     failureAction,
  recordFailure: (diag) => recordClaudeFailure(diag),
  log,
  beforeCall: ({ exempt = false, cfg = null, budgetMax = null } = {}) =>
    chargeClaudeCall({ exempt, cfg, max: budgetMax }),
  extraDiag: (cls) => ({
    label:        FAILURE_LABELS[cls.kind] || FAILURE_LABELS.unknown,
    exit_code:    cls.exit_code,
    signal:       cls.signal,
    stderr_empty: cls.stderr_empty,
    calls_used:   claudeCalls,
  }),
});
