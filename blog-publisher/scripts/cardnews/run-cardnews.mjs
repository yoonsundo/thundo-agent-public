#!/usr/bin/env node
/**
 * cardnews/run-cardnews.mjs — Orca 🐋 일일 오케스트레이터 (계획 §3.16, AC-18)
 *
 * 사용: node scripts/cardnews/run-cardnews.mjs
 * 계약: stdout **JSON 정확히 1줄** · exit 0=ok / 1=실패 / 2=예외
 *
 * 이 파일이 지키는 성질은 둘이다.
 *
 *  ① **모든 종료 경로가 `appendRun` 을 지난다**(정확히 1줄). `runs.jsonl` 이 post 단위가 아니라
 *     **런 단위**인 이유가 여기 있다 — `postIdFor()` 는 claude 의존 단계(backlog·pick·factcheck·
 *     script) *뒤에* 불리므로, 그 앞이 죽으면 post 가 아예 생기지 않아 인덱스엔 아무 흔적도
 *     남지 않는다. 07-25/26 이 정확히 그 모양이었고("왜인지 몰랐다"), 스펙 1-B 는 결방 자체가
 *     아니라 **원인 미상**을 실패로 친다. 그래서 step 0·0a·0b·0c 와 no-pick 경로까지 전부
 *     기록을 남긴다. `finish()` 가 한 번만 쓰이도록 잠금(latch)을 걸어 "1런 1줄"을 보장한다.
 *
 *  ② **단계 순서가 계약이다.** 토큰 유지보수가 sweep 보다 먼저인 것은 만료된 토큰으로 Meta 를
 *     쏘지 않기 위해서고, sweep 이 pick 보다 먼저인 것은 어제 끝맺지 못한 포스트가 오늘의
 *     상한을 먹어야 하기 때문이다(sweep 이 1건 발행하면 **즉시 반환** — 아니면 하루 2건이 된다).
 *
 * 🔴 **팩트체크 hold 를 인덱스에 남긴다**(`recordFactcheckHold`). `pick.mjs:pendingBacklog` 는
 * "인덱스에 있으면 소비됨"으로 판정하는데, hold 가 인덱스에 아무것도 안 남기면 doubtful 소재가
 * **매일 다시 최고점으로 뽑혀** 팩트체크 1콜을 태우고 또 hold 되는 무한 루프가 된다(pick.mjs 의
 * `pendingBacklog` docstring 이 "오케가 닫는다"고 적어 둔 공백이 이것이다). `planned → held` 로
 * 남기면 그 소재는 pending 풀에서 빠지고, `classifyHeld('factcheck:…')='permanent'` 라 sweep 도
 * 되살리지 않는다.
 *
 * 모든 외부 의존은 주입된다: `deps = {callClaude, meta, host, renderCards, imagenGenerate,
 * fetchImpl, notifier, sleep, now, token, checkBudget, charge, runTokenMaintenance}`.
 */
import { writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { makeLogger } from '../lib/log.mjs';
import {
  loadConfig, loadBacklog, loadIndex, getPost, transition, flush, postIdFor, workDir, bufferDir,
  appendRun, classifyHeld, resetClaudeCalls, claudeCallCount, callClaude as libCallClaude, kstDate,
  isMainModule,
} from './lib.mjs';
import { refillBacklog } from './backlog.mjs';
import { pick, pendingBacklog } from './pick.mjs';
import { factCheck, resolveFactcheck } from './factcheck.mjs';
import { generateScript, persistScripted, topUpBuffer, loadBuffer } from './script.mjs';
import { runGate as runGeneralizationGate } from './gate-generalization.mjs';
import { runGate as runQuoteGate } from './gate-quote.mjs';
import { judge as judgeImages } from './gates.mjs';
import { buildCaption } from './caption.mjs';
import { publishPost, sweepUnresolved } from './publish.mjs';
import { runTokenMaintenance as defaultTokenMaintenance } from './token.mjs';
import { resolveGenerator, makeWriter, resetCodexCalls, codexCallCount } from './writer.mjs';
import { recordPublishedPost as defaultRecordPublishedPost } from './post-record.mjs';
import { checkBudget as defaultCheckBudget, charge as defaultCharge } from '../watchdog/budget.mjs';
import * as metaModule from './meta.mjs';
import * as hostModule from './host.mjs';

const log = makeLogger('cardnews/run');

/** 런 기록의 `slot` — KST 시(`"11"`·`"19"`). 자정 '24' 로케일 함정을 피해 h23 을 명시한다. */
export function slotKey(now = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul', hour: '2-digit', hourCycle: 'h23',
  }).format(new Date(now));
}

/**
 * 팩트체크 hold 를 인덱스에 남긴다 — `planned → held`.
 *
 * post_id 는 오늘 날짜로 발급되므로 "오늘 이 소재를 시도했고 막혔다"가 기록되고, `backlog_id`
 * 가 채워지므로 `consumedBacklogIds` 가 내일부터 이 소재를 pending 에서 제외한다.
 * `held_reason` 은 `factcheck:` 접두를 유지한다(→ `classifyHeld` 가 `permanent` 로 분류 →
 * sweep 대상 아님 → "매일 같은 것이 올라오는" 증상이 구조적으로 불가능해진다).
 */
export function recordFactcheckHold(item, resolution, { now = new Date() } = {}) {
  const postId = postIdFor(item?.id, now);
  const diag = {
    stage: 'factcheck',
    verdict: String(resolution?.reason || '').replace(/^factcheck:/, '') || null,
    note: resolution?.note || null,
  };
  if (!getPost(postId)) {
    transition(postId, 'planned', {
      backlog_id: item?.id ?? null,
      subject: item?.subject ?? null,
      country: item?.country ?? null,
      domain: item?.domain ?? null,
      trigger_situation: item?.trigger_situation ?? null,
    }, { now });
  }
  const cur = getPost(postId);
  const patch = { held_reason: resolution?.reason || 'factcheck:doubtful', held_diag: diag };
  return cur.status === 'held'
    ? flush(postId, { ...patch, held_class: classifyHeld(patch.held_reason, diag) }, { now })
    : transition(postId, 'held', patch, { now });
}

/**
 * 버려진 중간 상태 회수 — `planned`/`scripted` 가 하루 넘게 방치되면 `held` 로 내린다.
 *
 * 🔴 왜 필요한가: `pendingBacklog` 는 **인덱스에 있으면 소비된 것**으로 본다. `runDaily` 는
 * `generateScript` 앞에서 `planned` 를 만들므로, 대본 생성이 실패하면(claude 장애 등) 그 소재는
 * 인덱스에 `planned` 로 남아 **영원히 다시 뽑히지 않는다** — 장애 하루당 백로그 1건이 조용히
 * 타버린다. 게다가 `planned` 는 sweep 대상도 아니고 `held` 도 아니라서 `held_class` 가 없고,
 * 그래서 **1-B(실패일 원인 분류 가능)에서 아예 보이지 않는다.** 분류되지 않는 실패가 지표에서
 * 사라지는 건 이 채널이 되풀이하지 않기로 한 바로 그 실패 방식이다.
 *
 * `held(transient)` 로 내리면 (a) 1-B 에 잡히고 (b) sweep 의 transient 되살리기 대상이 되며
 * (c) 그래도 안 되면 다음 날 새 post_id 로 정상 진행된다.
 *
 * @returns {{reaped:number, ids:string[]}}
 */
export function reapAbandoned({ now = new Date(), maxAgeMs = 24 * 3600 * 1000 } = {}) {
  const idx = loadIndex();
  const t = new Date(now).getTime();
  const ids = [];
  for (const [postId, post] of Object.entries(idx)) {
    if (post?.status !== 'planned' && post?.status !== 'scripted') continue;
    // 시각은 `history` 마지막 항목에 있다 — 포스트 최상위에는 타임스탬프가 없다.
    // ⚠ `Date.parse(x || 0)` 로 폴백하면 `Date.parse("0")` 이 **서기 2000년**으로 파싱돼
    //    모든 포스트가 "오래됨"이 된다(실제로 이 버그를 테스트가 잡았다). 못 읽으면 건너뛴다.
    const hist = Array.isArray(post.history) ? post.history : [];
    const stamp = hist.length ? hist[hist.length - 1]?.at : post.attempt_started_at;
    const at = stamp ? Date.parse(stamp) : NaN;
    if (!Number.isFinite(at) || t - at < maxAgeMs) continue;
    const reason = `${post.status}:abandoned`;
    const diag = { stage: post.status, note: '24시간 넘게 중간 상태로 방치 — 회수' };
    try {
      transition(postId, 'held', { held_reason: reason, held_diag: diag, held_class: classifyHeld(reason, diag) }, { now });
      ids.push(postId);
    } catch (e) {
      log.warn(`회수 실패(비차단) ${postId}: ${e.message}`);
    }
  }
  if (ids.length) log.info(`버려진 중간 상태 ${ids.length}건 회수 → held`);
  return { reaped: ids.length, ids };
}

/**
 * 버퍼 파일 경로 — `script.mjs:bufferFile` 과 **같은 규칙**(그 함수는 export 되지 않는다).
 * 규칙이 갈리면 소비 후 rename 이 엉뚱한 파일을 건드리므로, 바꿀 일이 생기면 양쪽을 같이 고친다.
 */
const bufferFilePath = (backlogId) =>
  join(bufferDir(), `${String(backlogId).replace(/[^A-Za-z0-9_-]/g, '')}.json`);

/**
 * 예비 대본 소비 (§3.16.1) — claude 가 죽은 날에도 그날치를 낸다.
 *
 * 🔴 post_id 를 **오늘 날짜로 재발급**한다. 적립 당시 id 를 그대로 쓰면 `idem_marker` 와
 * content-addressed 저장 경로(`host.objectPath` 가 post_id 에서 날짜를 되판다)가 과거를 가리켜
 * 슬롯 재사용·reconciliation 매칭이 어긋난다.
 *
 * ⚠ 적립 시점의 TIER-1 게이트는 적립 당시 post_id 로 돌았지만, **게이트 입력은 대본 텍스트뿐이고
 * post_id 에 의존하지 않으므로 판정은 그대로 유효하다**(§3.16.1).
 */
export function consumeBuffer({ now = new Date() } = {}) {
  const row = loadBuffer()[0];
  if (!row) return null;
  const postId = postIdFor(row.backlog_id, now);
  const script = { ...row.script, post_id: postId };

  transition(postId, 'planned', {
    backlog_id: row.backlog_id,
    subject: row.provenance?.subject ?? script.cover?.headline ?? null,
    country: script.cover?.country ?? null,
    from_buffer: true,
  }, { now });
  transition(postId, 'scripted', {
    provenance: row.provenance ?? null,
    tier2_warnings: Array.isArray(row.tier2_warnings) ? row.tier2_warnings : [],
  }, { now });

  // 대본을 포스트 작업공간에 남긴다 — resume 재렌더(`publish.mjs:defaultRerender`)가 이 파일을
  // 읽는다. 버퍼에서 온 대본만 이 파일이 없으면, 하필 장애일에 만든 포스트가 재개 불가가 된다.
  try {
    const dir = workDir(postId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'script.json'), JSON.stringify(script, null, 2) + '\n', 'utf8');
  } catch (e) {
    log.warn(`buffer 대본 저장 실패(비차단): ${e.message}`);
  }

  // 단일 소비 — rename 이 원자적이라 두 프로세스가 같은 대본을 두 번 쓰지 못한다.
  const p = bufferFilePath(row.backlog_id);
  try { renameSync(p, `${p}.consumed`); } catch (e) { log.warn(`buffer 소비 마킹 실패: ${e.message}`); }

  return { post_id: postId, script, row };
}

/**
 * 하루 1회 런.
 *
 * @returns {Promise<{ok:boolean, post_id?:string|null, media_id?:string|null, state:string|null,
 *                     reason?:string, swept?:string[], steps:Array}>}
 */
export async function runDaily(opts = {}) {
  const cfg = opts.cfg || loadConfig();
  const deps = opts.deps || {};
  const clock = deps.now || (() => new Date());
  const now = () => new Date(clock());
  const started = now();
  const slot = opts.slot ?? slotKey(started);
  const steps = [];
  const rec = (step, ok, detail = null) => { steps.push({ step, ok, detail }); };

  // 프로세스 = 런이지만, 테스트·재진입에서 이전 카운트가 다음 런을 굶기지 않도록 초기화한다.
  resetClaudeCalls();
  resetCodexCalls();

  const baseCall = deps.callClaude || libCallClaude;
  const chargeFn = deps.charge || defaultCharge;
  /** claude 1콜 = 공유 예산 원장 1콜(F4). 실패해도 계상한다 — 호출은 실제로 일어났다. */
  const charged = (label, extra = {}) => (prompt, o = {}) => {
    try { return baseCall(prompt, { ...o, ...extra }); }
    finally { try { chargeFn(0, 1, `cardnews-${label}`); } catch (e) { log.warn(`예산 계상 실패(비차단): ${e.message}`); } }
  };

  const meta = deps.meta || metaModule;
  const host = deps.host || hostModule;
  const pubDeps = { meta, host, notifier: deps.notifier, sleep: deps.sleep, now: deps.now };

  // ── 이중 생성 배정 ─────────────────────────────────────────────────────────
  // 슬롯 시각으로 작가를 결정론 배정한다(11시=클로드 · 19시=코덱스). 소재가 겹치지 않는 것은
  // `pendingBacklog` 가 이미 보장한다 — 11시 글의 backlog_id 가 인덱스에 들어가므로 19시 pick
  // 은 같은 소재를 뽑을 수 없다. 따라서 여기서는 **작가만** 정하면 된다.
  const generator = deps.generator || resolveGenerator(cfg, started);
  const fallbacks = [];

  let stage = 'init';
  let postId = null;
  let via = null;
  let recorded = false;
  /** 🔴 런당 정확히 1줄. 두 번째 호출은 무시된다(경로가 겹쳐도 기록이 부풀지 않는다). */
  const finish = (record) => {
    if (recorded) return null;
    recorded = true;
    return appendRun({
      slot, started_at: started.toISOString(), ended_at: now().toISOString(),
      post_id: postId, via, now: now(),
      // 어느 AI 가 썼는지는 발행 성패와 무관하게 남긴다 — 모델별 성과를 나중에 보려면
      // 실패한 런까지 포함해야 분모가 맞는다.
      generator, generator_fallback: fallbacks.length ? fallbacks : null,
      codex_calls: codexCallCount(),
      ...record,
    });
  };

  const alert = async (event, payload) => {
    try { if (typeof deps.notifier === 'function') return await deps.notifier(event, payload); }
    catch (e) { log.warn(`경보 실패(비차단, ${event}): ${e.message}`); }
    log.warn(`[경보:${event}] ${JSON.stringify(payload)}`);
    return null;
  };

  /** held 기록 — 이미 held 면 사유만 갱신(전이표에 held→held 간선은 없다). */
  const heldNow = (reason, diag = null) => {
    if (!postId || !getPost(postId)) return null;
    const cur = getPost(postId);
    return cur.status === 'held'
      ? flush(postId, { held_reason: reason, held_class: classifyHeld(reason, diag), held_diag: diag }, { now: now() })
      : transition(postId, 'held', { held_reason: reason, held_diag: diag }, { now: now() });
  };

  /** held 로 내리고 런을 닫는다. */
  const bail = (reason, failureStage, diag = null) => {
    const failure_class = classifyHeld(reason, diag);
    heldNow(reason, diag);
    finish({ outcome: 'held', failure_class, failure_stage: failureStage, diag: { reason, ...(diag || {}) } });
    log.warn(`런 종료 — held(${failure_class}): ${reason}`);
    return { ok: false, post_id: postId, state: 'held', reason, held_class: failure_class, steps };
  };

  try {
    // ── 0. 킬스위치 ─────────────────────────────────────────────────────────
    if (cfg.enabled === false) {
      finish({ outcome: 'skipped-disabled' });
      return { ok: true, skipped: 'disabled', state: null, steps };
    }

    // ── 0a. 토큰 유지보수 — sweep 보다 **먼저** (만료 토큰으로 Meta 를 쏘지 않는다) ──
    stage = 'token';
    const tokenMaintenance = deps.runTokenMaintenance || defaultTokenMaintenance;
    const t = await tokenMaintenance({
      cfg, now: now(), fetchImpl: deps.fetchImpl, notifier: deps.notifier,
    });
    if (t?.plan?.action === 'halt') {
      rec('token', false, t.plan);
      finish({
        outcome: 'halt', failure_class: 'external', failure_stage: 'token',
        diag: { kind: 'token-expired', action: 'halt', alerted: Boolean(t.alerted), reason: t.reason ?? null },
      });
      log.error('토큰 만료 — 발행 중단(pending 보존). sweep 도 돌리지 않는다.');
      return { ok: false, state: null, reason: 'token:halt', steps };
    }
    rec('token', true, t?.plan ?? null);

    // ── 0b. 예산 (F4) ───────────────────────────────────────────────────────
    stage = 'budget';
    const checkBudget = deps.checkBudget || defaultCheckBudget;
    const budget = checkBudget();
    if (!budget?.ok) {
      rec('budget', false, budget ?? null);
      finish({ outcome: 'halt', failure_class: 'external', failure_stage: 'budget', diag: budget ?? null });
      log.error('예산 소진 — 런 중단(claude·Meta 호출 0회).');
      return { ok: false, state: null, reason: 'budget', steps };
    }
    rec('budget', true, { calls_used: budget.calls_used, tokens_used: budget.tokens_used });

    // ── 0b-2. 설정 정합성 — 카드 장수 두 출처가 어긋나면 즉시 세운다 ─────────
    //
    // 🔴 `gates.expected_count` 와 `cards.body_count` 는 카드 장수의 **독립된 두 출처**다.
    // `gates.mjs` 는 결정론 게이트라 `script.mjs` 를 import 하지 않으므로(그게 맞다 — LLM
    // 의존을 게이트에 끌어들이면 안 된다) 둘을 코드로 묶을 수가 없고, 손으로 맞춰야 한다.
    // 어긋나면 게이트가 fail-closed 로 **매일** `held(gate:image)` 를 내고, 그 held 는
    // `permanent` 로 분류되어 "콘텐츠 품질 문제"처럼 보인다. 설정 오타 하나가 원인 불명의
    // 영구 결방으로 위장하는 셈이다. 런 시작에 한 번 대조해 시끄럽게 세운다.
    const bodyN = Number(cfg.cards?.body_count ?? 5);
    const expectN = Number(cfg.gates?.expected_count ?? bodyN + 2);
    if (expectN !== bodyN + 2) {
      const msg = `설정 불일치: gates.expected_count=${expectN} ≠ cards.body_count(${bodyN})+2. `
        + '이대로 두면 이미지 게이트가 매일 fail-closed 로 결방시킨다.';
      log.error(msg);
      rec('config', false, { body_count: bodyN, expected_count: expectN });
      finish({ outcome: 'error', failure_stage: 'config', failure_class: 'permanent', diag: { msg } });
      return { ok: false, state: null, reason: 'config-mismatch', steps };
    }
    rec('config', true, { body_count: bodyN, expected_count: expectN });

    // ── 0b-3. 일일 상한 — 멱등 가드 ─────────────────────────────────────────
    //
    // 🔴 cron 은 하루 여러 번 깨운다(11시 본 슬롯 + 19시 보충). 여기 가드가 없으면 슬롯마다
    // 한 건씩 나가 **하루 2건**이 된다. 인스타는 삭제 API 가 없으므로 되돌릴 수 없다.
    // 계획은 이 가드를 `slot.mjs`(Step 6)에 두었지만, 그 파일이 생기기 전에 cron 이 먼저
    // 걸리면 그날로 사고다 — 오케 자체가 막는 편이 안전하다(이중이어도 무해하다).
    //
    // sweep 보다 **앞**에 둔다: 어제 멈춘 글을 sweep 이 오늘 마무리해도 그건 오늘 나간 1건이다.
    // 오늘 이미 냈다면 sweep 의 발행도 2건째가 된다.
    // 🔴 상한의 **단일 출처는 `slot.daily_cap`** 이다. 예전 코드는 `publish.daily_cap` 을 먼저
    // 봤는데 그 키는 config 에 존재한 적이 없어 항상 `pick.daily_target` 로 떨어졌다 —
    // config 의 `slot.daily_cap` 을 고쳐도 아무 일도 안 일어나는 죽은 손잡이였다.
    // 하루 2편으로 올리는 지금은 그 착시가 곧 사고이므로 여기서 정리한다.
    const cap = Number(cfg.slot?.daily_cap ?? cfg.publish?.daily_cap ?? cfg.pick?.daily_target ?? 1);
    const today = kstDate(started);
    const publishedToday = Object.values(loadIndex()).filter(
      p => p?.status === 'published' && p?.published_at && kstDate(new Date(p.published_at)) === today,
    ).length;
    if (publishedToday >= cap) {
      log.info(`오늘(${today}) 이미 ${publishedToday}건 발행 — 상한 ${cap}. 이번 슬롯은 건너뛴다.`);
      rec('daily_cap', true, { published_today: publishedToday, cap });
      finish({ outcome: 'skipped-cap' });
      return { ok: true, state: null, reason: 'daily_cap', skipped: 'daily_cap', steps };
    }
    rec('daily_cap', true, { published_today: publishedToday, cap });

    // ── 0c-0. 버려진 중간 상태 회수 — sweep 앞 ─────────────────────────────
    // sweep 은 `held(transient)` 를 되살릴 수 있으므로, 회수를 먼저 해야 그날 안에 구제된다.
    try {
      const reaped = reapAbandoned({ now: now() });
      if (reaped.reaped) rec('reap', true, { reaped: reaped.reaped, ids: reaped.ids.slice(0, 5) });
    } catch (e) { log.warn(`회수 단계 실패(비차단): ${e.message}`); }

    // ── 0c. sweep — 토큰 뒤, pick 앞 ────────────────────────────────────────
    stage = 'publish';
    const sweep = await sweepUnresolved({
      cfg, token: deps.token ?? null, deps: pubDeps, fetchImpl: deps.fetchImpl,
    });
    rec('sweep', !sweep.skipped, {
      skipped: sweep.skipped ?? null, swept: sweep.swept, published: sweep.published, held: sweep.held,
    });
    if (sweep.published > 0) {
      // 🔴 그날의 상한은 소비됐다 — 여기서 계속 가면 하루 2건이 나간다(§7.3 시나리오 24).
      postId = (sweep.results || []).find(r => r.ok && r.mediaId)?.post_id ?? null;
      via = 'sweep';
      finish({ outcome: 'published' });
      log.info(`sweep 이 ${sweep.published}건을 마무리 — 오늘 신규 제작은 생략한다.`);
      return { ok: true, post_id: postId, state: 'published', swept: sweep.swept, consumed_by: 'sweep', steps };
    }

    // ── 1. 백로그 보충 ──────────────────────────────────────────────────────
    stage = 'backlog';
    const dailyTarget = cfg.pick?.daily_target ?? 1;
    const bufferDays = cfg.backlog?.refill_buffer_days ?? 5;
    const threshold = Math.max(1, dailyTarget * bufferDays);
    const pendingBefore = pendingBacklog().length;
    if (pendingBefore < threshold) {
      try {
        const r = refillBacklog({ cfg, deps: { callClaude: charged('backlog') } });
        rec('backlog', true, { pending_before: pendingBefore, added: r.added, total: r.total });
      } catch (e) {
        // 보충 실패는 그날을 죽이지 않는다 — 남은 재고로 간다. 예산 초과만 예외(폭주 방지).
        if (e.budget) throw e;
        log.warn(`백로그 보충 실패(비차단): ${e.message}`);
        rec('backlog', false, { pending_before: pendingBefore, reason: e.message });
      }
    } else {
      rec('backlog', true, { pending_before: pendingBefore, skipped: 'sufficient' });
    }

    // ── 2. 선정 ─────────────────────────────────────────────────────────────
    stage = 'pick';
    const picked = pick({ cfg, deps: { callClaude: charged('pick') } });
    // 후보 순위는 breakdown 에 있지만 필드가 잘려 있다 → 백로그 원본으로 되돌린다.
    // (다음 후보를 위해 pick 을 다시 부르면 채점 1콜이 더 나간다 — 예산 9콜에서 큰 값이다.)
    const byId = new Map(loadBacklog().map(b => [b.id, b]));
    let candidates = (picked?.breakdown || []).map(x => byId.get(x.id)).filter(Boolean);
    if (!candidates.length && picked?.pick) candidates = [picked.pick];
    rec('pick', Boolean(picked?.pick), {
      id: picked?.pick?.id ?? null, score: picked?.score ?? 0,
      reason: picked?.reason ?? null, candidates: candidates.length,
    });

    // ── 3. 팩트체크 — 최대 3후보 ────────────────────────────────────────────
    stage = 'factcheck';
    let item = null, factcheck = null, script = null;
    const holds = [];
    for (const cand of candidates.slice(0, 3)) {
      const fc = factCheck(cand, { cfg, deps: { callClaude: charged('factcheck') } });
      const res = resolveFactcheck(cand, fc);
      if (res.action === 'produce') { item = res.item; factcheck = fc; break; }
      // 🔴 인덱스에 남긴다 — 이게 없으면 doubtful 소재가 매일 다시 뽑힌다.
      const held = recordFactcheckHold(cand, res, { now: now() });
      holds.push({ post_id: held.post_id, backlog_id: cand.id, reason: res.reason });
      log.warn(`팩트체크 hold: ${res.reason} [${cand.id}] — ${res.log}`);
    }
    rec('factcheck', Boolean(item), { chosen: item?.id ?? null, holds });

    // ── 2·3 실패 처리 — 후보가 없으면 buffer, 그것도 없으면 no-pick ─────────
    if (!item) {
      if (!candidates.length) {
        const consumed = consumeBuffer({ now: now() });
        if (consumed) {
          postId = consumed.post_id;
          script = consumed.script;
          via = 'buffer';
          rec('buffer', true, { consumed: consumed.row.backlog_id, post_id: postId });
          log.info(`후보 없음 → 예비 대본 소비 [${postId}]`);
        } else {
          stage = 'pick';
          finish({ outcome: 'no-pick', diag: { reason: picked?.reason ?? 'no-candidates' } });
          log.warn(`오늘의 후보 없음(${picked?.reason ?? 'no-candidates'}) · 예비 대본도 없음`);
          return { ok: true, pick: null, state: null, reason: picked?.reason ?? 'no-candidates', steps };
        }
      } else {
        // 후보는 있었는데 3건 전부 팩트체크에서 막혔다 — 오늘은 내지 않는다.
        postId = holds[0]?.post_id ?? null;
        finish({
          outcome: 'held', failure_class: 'permanent', failure_stage: 'factcheck',
          diag: { holds: holds.map(h => h.reason) },
        });
        return { ok: false, post_id: postId, state: 'held', reason: 'factcheck:all-held', steps };
      }
    }

    // ── 4·5. post_id 발급 → planned → 대본 → scripted ──────────────────────
    if (!script) {
      stage = 'script';
      postId = postIdFor(item.id, now());
      if (!getPost(postId)) {
        transition(postId, 'planned', {
          backlog_id: item.id, subject: item.subject ?? null, country: item.country ?? null,
          domain: item.domain ?? null, trigger_situation: item.trigger_situation ?? null,
        }, { now: now() });
      }
      // 작가 배정 — 코덱스가 실패하면 클로드가 대신 쓴다(사용자 결정: "매일 2편"이 우선).
      // 폴백을 `fallbacks` 에 남겨야 나중에 "왜 오늘 두 편이 같은 문체인가"를 설명할 수 있다.
      const writer = makeWriter('script', {
        cfg, generator,
        callClaude: charged('script'),
        callCodexImpl: deps.callCodex,
        onFallback: (f) => fallbacks.push(f),
      });
      const gen = generateScript(item, { cfg, postId, deps: { callClaude: writer.call } });
      script = gen.script;
      // provenance 는 **대본 시점**에 남긴다 — 발행까지 못 간 held 포스트도 "왜 믿었는가"를
      // 물어볼 수 있다(테이크다운 런북).
      persistScripted(postId, { item, script, factcheck });
      // 포스트에도 남긴다 — 갤러리·리포트가 "이 글은 누가 썼나"를 런 기록을 뒤지지 않고 읽는다.
      flush(postId, {
        generator: writer.generator,
        generator_effective: fallbacks.length ? 'claude' : writer.generator,
      }, { now: now() });
      rec('script', true, {
        attempts_used: gen.attempts_used, post_id: postId,
        generator: writer.generator, fell_back: fallbacks.length > 0,
      });
    } else {
      rec('script', true, { from_buffer: true, post_id: postId });
    }

    // ── 6-0. 인용 안전 게이트 — 렌더 전, 일반화 게이트 앞 ───────────────────
    //
    // 🔴 이 채널의 실질 법적 위험(저작권)과 최대 사고 확률(가짜 인용)을 둘 다 여기서 막는다.
    // 원문 대조는 결정론이라 LLM 판정보다 강하다 — 팩트체크(hedgehog)가 이미 봤더라도
    // 여기서 한 번 더 보는 건 중복이 아니라 **의도된 이중화**다. 팩트체크는 LLM 경로가
    // 섞이고 이쪽은 순수 대조이므로, 둘이 같은 것을 보되 실패 방식이 다르다.
    //
    // ⚠ 두 판정을 구분해서 다룬다:
    //   not_found  = 그 책에 그 구절이 없다 → **가짜 인용**. permanent, 소재를 버린다.
    //   unavailable = 원문을 못 받았다(네트워크·캐시 부재) → **확인 불가**. transient,
    //                 소재는 살리고 다음 런에서 다시 본다. 이걸 permanent 로 받으면
    //                 네트워크가 한 번 흔들린 날 멀쩡한 소재가 영구 폐기된다.
    stage = 'gate';
    const q = await runQuoteGate(script, { cfg, postId });
    rec('gate_quote', q.pass, {
      reason: q.reason,
      hits: q.evidence?.hits?.length ?? 0,
      warns: q.evidence?.warns?.length ?? 0,
    });
    if (!q.pass) {
      const transient = Boolean(q.evidence?.transient)
        || (q.evidence?.hits || []).some(h => h?.transient);
      return bail(`gate:quote:${transient ? 'unavailable' : 'blocked'}`, 'gate', {
        hits: q.evidence?.hits, transient,
      });
    }

    // ── 6. 일반화 게이트 — 렌더 전(Playwright·Supabase 비용 앞) ─────────────
    const g = runGeneralizationGate(script, { cfg, postId });
    rec('gate', g.pass, {
      reason: g.reason,
      tier1: g.evidence.tier1_hits.length, tier2: g.evidence.tier2_warnings.length,
    });
    if (!g.pass) {
      return bail('gate:generalization', 'gate', { tier1_hits: g.evidence.tier1_hits });
    }
    if (g.evidence.tier2_warnings.length) {
      // TIER-2 는 비차단 — 리뷰 큐(runGate 가 이미 append)에 남기고 경보만 띄운 뒤 발행한다.
      flush(postId, { tier2_warnings: g.evidence.tier2_warnings }, { now: now() });
      await alert('CARDNEWS_TIER2_WARN', {
        post_id: postId, count: g.evidence.tier2_warnings.length,
        warnings: g.evidence.tier2_warnings.slice(0, 5),
      });
    }

    // ── 7. 렌더 → 이미지 게이트 ─────────────────────────────────────────────
    stage = 'render';
    const attemptId = getPost(postId)?.attempt_id || 'att-1';
    const dir = workDir(postId, attemptId);
    // playwright 체인은 여기서만 필요하다 — 오케 import 가 브라우저를 끌고 오지 않게 지연 로드.
    const renderCards = deps.renderCards || (await import('./render.mjs')).renderCards;
    const rendered = await renderCards(script, { dir, cfg, generate: deps.imagenGenerate });
    if (!rendered.ok) {
      rec('render', false, { reason: rendered.reason ?? null });
      return bail(`render:${rendered.reason || 'failed'}`, 'render', { dir });
    }
    transition(postId, 'rendered', {
      slide_files: rendered.files, slide_sha256: rendered.sha256,
    }, { now: now() });
    const imageGate = judgeImages(rendered.files, cfg);
    rec('render', imageGate.ok, {
      files: rendered.files.length, quality: rendered.quality,
      background: rendered.background?.mode ?? null, checks: imageGate.checks,
    });
    if (!imageGate.ok) {
      // ⛔ 산출물은 지우지 않는다(AC-19) — 진단·재사용 자산이다.
      return bail('gate:image', 'gate', {
        failed: imageGate.checks.filter(c => !c.pass).map(c => `${c.name}:${c.detail}`), dir,
      });
    }

    // ── 8. 호스팅 ───────────────────────────────────────────────────────────
    stage = 'host';
    const hosted = await host.hostSlides(rendered.files, rendered.sha256, {
      postId, cfg, now: now(), fetchImpl: deps.fetchImpl,
    });
    rec('host', hosted.ok, { urls: hosted.urls?.length ?? (hosted.uploadedUrls?.length ?? 0), reason: hosted.reason ?? null });
    if (!hosted.ok) return bail(`host:${hosted.reason || 'failed'}`, 'host');
    transition(postId, 'hosted', {
      public_url: hosted.urls, hosted_at: now().toISOString(),
    }, { now: now() });

    // ── 9. 캡션 ─────────────────────────────────────────────────────────────
    const caption = buildCaption({
      hook: script.caption_sections?.hook,
      body: script.caption_sections?.body,
      cta: script.caption_sections?.cta,
      hashtags: script.hashtags,
      postId,
    }, cfg);
    flush(postId, {
      caption: caption.caption, hashtag_count: caption.hashtagCount, idem_marker: caption.idemMarker,
    }, { now: now() });
    rec('caption', true, { chars: caption.chars, hashtags: caption.hashtagCount, truncated: caption.truncated });

    // ── 9-b. 사이트 DB 기록 (status='ready') ────────────────────────────────
    // 🔴 **발행보다 먼저** 기록한다(2026-08-21 반자동 전환). 인스타 캐러셀에 음악을 넣을 수
    //    없어 자동 발행을 포기했고, 지금은 `publish.enabled=false` 라 아래 10단계가 게시를
    //    하지 않는다. 예전처럼 "발행 성공 뒤에만 기록"하면 **관리자 화면이 영원히 빈다** —
    //    관리자가 올릴 대상 자체가 DB 에 안 들어오기 때문이다.
    //    여기까지 오면 슬라이드는 호스팅됐고 캡션도 확정이라 사람이 올릴 준비가 끝난 상태다.
    //    media_id 가 없으므로 post-record 가 status='ready' 로 넣고, 아래에서 자동 발행이
    //    성공하면 같은 행을 published 로 다시 upsert 한다(같은 post_id, on conflict).
    const recorder = deps.recordPublishedPost || defaultRecordPublishedPost;
    const recordToSite = async (label) => {
      try {
        const r = await recorder(postId, { fetchImpl: deps.fetchImpl });
        if (!r?.ok) log.warn(`사이트 DB 기록 실패(비차단·${label}): ${r?.skipped || r?.error}`);
        rec('site_record', Boolean(r?.ok), { phase: label, skipped: r?.skipped ?? null, error: r?.error ?? null });
        return r;
      } catch (e) {
        log.warn(`사이트 DB 기록 예외(비차단·${label}): ${e.message}`);
        rec('site_record', false, { phase: label, error: e.message });
        return null;
      }
    };
    await recordToSite('ready');

    // ── 10. 발행 (내부 step 0 이 초크포인트) ────────────────────────────────
    stage = 'publish';
    const published = await publishPost(postId, {
      cfg, token: deps.token ?? null, deps: pubDeps, fetchImpl: deps.fetchImpl,
    });
    rec('publish', Boolean(published.ok), {
      media_id: published.mediaId ?? null, state: published.state ?? null,
      reason: published.reason ?? published.held ?? null,
    });

    // ── 11. 종료 기록 ───────────────────────────────────────────────────────
    if (published.ok && published.mediaId) {
      // 사이트 갤러리(`/cardnews`)가 읽는 테이블에 한 행 남긴다. 발행은 이미 끝났으므로
      // 여기 실패는 런을 죽이지 않는다 — 인스타는 되돌릴 수 없고, 이 행은 다음 런이나
      // 손으로도 채울 수 있다. 다만 조용히 넘기지는 않는다(갤러리가 비는 원인이 된다).
      // 자동 발행이 성공했으면 같은 행을 published 로 덮는다(같은 post_id upsert).
      // 실패해도 런을 죽이지 않는다 — 인스타는 되돌릴 수 없고, ready 행은 이미 들어가 있다.
      await recordToSite('published');

      await topUp({ cfg, charged, candidates, usedIds: usedBacklogIds(item, holds), now: now() });
      finish({ outcome: 'published' });
      log.info(`발행 완료 [${postId}] media=${published.mediaId} · claude ${claudeCallCount()}콜`);
      return { ok: true, post_id: postId, media_id: published.mediaId, state: 'published', steps };
    }
    if (published.held) {
      const failure_class = published.held_class || classifyHeld(published.held);
      finish({
        outcome: 'held', failure_class, failure_stage: 'publish',
        diag: { reason: published.held, state: published.state ?? null },
      });
      return { ok: false, post_id: postId, state: published.state ?? 'held', reason: published.held, held_class: failure_class, steps };
    }
    // `publish_unknown` 등 — held 도 아니고 발행도 아니다. 실패일로 세되 갈래는 남긴다.
    finish({
      outcome: 'error', failure_class: 'transient', failure_stage: 'publish',
      diag: { state: published.state ?? null, reason: published.reason ?? null },
    });
    return { ok: false, post_id: postId, state: published.state ?? null, reason: published.reason ?? 'publish-failed', steps };
  } catch (e) {
    // 🔴 post 가 생기기 전에 죽어도 여기서 반드시 1줄이 남는다(1-B).
    const diag = e.diag || (e.budget ? { kind: 'budget', ...e.budget } : null);
    const failure_stage = e.budget ? 'budget' : stage;
    const failure_class = e.budget ? 'external' : classifyHeld(`${stage}:${e.message}`, diag);
    finish({
      outcome: 'error', failure_class, failure_stage,
      diag: diag || { kind: 'unknown', message: String(e?.message ?? e).slice(0, 300) },
    });
    log.error(`런 예외(${failure_stage}/${failure_class}): ${e?.message ?? e}`);
    return { ok: false, post_id: postId, state: null, error: String(e?.message ?? e), steps };
  }
}

/** 이번 런에서 이미 쓴 백로그 id — top-up 이 같은 소재를 다시 집지 않게 한다. */
function usedBacklogIds(item, holds) {
  return new Set([item?.id, ...holds.map(h => h.backlog_id)].filter(Boolean));
}

/**
 * 예비 대본 적립 — **발행 성공 뒤에만** 돈다.
 *
 * claude 호출은 `exempt:true`(계상은 하되 throw 는 않는다). 여기서 예산 초과로 던지면 **이미
 * 나간 그날이 실패로 기록되고 결방 경보가 오발한다**(§3.6 `topUpBuffer` 주석). 적립 자격은
 * `bankToBuffer` 가 강제한다 — 팩트체크 ok + TIER-1 통과분만.
 */
async function topUp({ cfg, charged, candidates, usedIds, now }) {
  try {
    if ((cfg.buffer?.target ?? 5) <= 0) return null;
    const queue = candidates.filter(c => c && !usedIds.has(c.id));
    const r = topUpBuffer({
      cfg, now,
      produce: () => {
        const cand = queue.shift();
        if (!cand) return null;
        const fc = factCheck(cand, { cfg, deps: { callClaude: charged('topup-factcheck', { exempt: true }) } });
        const res = resolveFactcheck(cand, fc);
        if (res.action !== 'produce') {
          // top-up 에서 걸린 hold 도 인덱스에 남긴다 — 그래야 내일 pick 이 또 집지 않는다.
          recordFactcheckHold(cand, res, { now });
          return { backlogId: cand.id, script: null, factcheckVerdict: fc.verdict, gatePass: false };
        }
        const gen = generateScript(res.item, {
          cfg, deps: { callClaude: charged('topup-script', { exempt: true }) },
        });
        const gate = runGeneralizationGate(gen.script, { cfg, postId: null, appendQueue: false });
        return {
          backlogId: cand.id, script: gen.script,
          provenance: {
            subject: res.item?.subject ?? null,
            source_hint: res.item?.source_hint ?? null,
            factcheck_verdict: fc.verdict, factcheck_source: fc.source ?? null, factcheck_note: fc.note ?? null,
            factcheck_corrected: Boolean(res.item?.factcheck_corrected),
          },
          tier2Warnings: gate.evidence.tier2_warnings,
          factcheckVerdict: fc.verdict, gatePass: gate.pass,
        };
      },
    });
    return r;
  } catch (e) {
    log.warn(`buffer 적립 실패(비차단 — 발행은 이미 끝났다): ${e.message}`);
    return null;
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  let r;
  try {
    r = await runDaily({});
  } catch (e) {
    // runDaily 는 스스로 삼키지만, 설정 로드 같은 진입 이전 실패는 여기로 온다.
    process.stdout.write(JSON.stringify({ ok: false, error: String(e?.message ?? e) }) + '\n');
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(r) + '\n');
  process.exit(r.ok ? 0 : (r.error ? 2 : 1));
}

if (isMainModule(import.meta.url)) main();
