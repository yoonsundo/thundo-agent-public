/**
 * cardnews/publish.mjs — 발행 상태 머신 (계획 §3.14 · Step 4b)
 *
 * 이 모듈이 지키는 성질은 하나다: **같은 게시물을 두 번 올리지 않는다.** 인스타 발행은
 * 되돌릴 수 없고(우리 코드로 지울 수 없다), 그래서 "모르면 다시 쏜다"가 가장 비싼 오답이다.
 * 네 가지 장치가 그걸 구조로 만든다.
 *
 *  ① **flush vs transition** — resume 진입 지점에서 같은 상태로 필드만 남기는 건 전부
 *     `flush` 다. 전이표(§5.2)는 write-ahead 를 모르므로, `child_containers_partial` 이나
 *     `publish_unknown` 으로 재진입해 `transition('hosted')` 를 부르면 불허 간선에 걸려
 *     **일을 시작하기도 전에 죽는다**. 예전 개정판이 정확히 그렇게 죽었고, 테스트는 그 경로로
 *     "진입"하지 않고 흉내만 내서 통과했다. 그래서 §7.3 시나리오 18은 6개 상태 **각각으로
 *     직접 진입**한다.
 *  ② **재사용은 슬롯 단위** — 유효성(나이<20h + sha 일치 + URL 일치)은 인덱스별로 따지고,
 *     완결성(7개)은 캐러셀 진입 조건일 뿐이다. 7개 중 3개만 살아 있으면 3개를 재사용하고
 *     4개만 새로 만든다. TTL 이 24h 가 아니라 **20h** 인 이유는 자식 7회 순차 생성 + 캐러셀이
 *     24h 경계를 넘을 수 있어서다. `child_created_at` 은 Meta 가 주지 않으므로 **호출 직전
 *     우리 시계**를 쓴다(만료를 과대추정 = 안전한 쪽).
 *  ③ **media_publish 는 절대 맹목 재시도하지 않는다** — 타임아웃·5xx 는 "실패"가 아니라
 *     "모름"이다. `publish_unknown` 으로 적고 reconciliation 으로 확인한다. 카운터가 둘인
 *     이유도 여기 있다: `publish_issued_count`(상한 3)는 폭주 백스톱이고,
 *     `publish_confirmed_failed_count`(상한 1)만 재발행을 연다. 하나로 합쳐 시도 횟수를
 *     상한 1로 세면 "미발행이 확정된" **증명 가능하게 안전한 분기가 영원히 도달 불가**가 되고,
 *     그 날은 조용히 결방이 된다.
 *  ④ **모든 발행 경로가 가드를 통과한다** — `sweepUnresolved` 는 `reconcile` 을 직접 부르고
 *     `reconcile` 은 재발행할 수 있으므로, sweep 이 자기 step 0 에서 가드를 받아 내려보낸다.
 *     `issuePublish` 도 가드를 못 받으면 **스스로** 발급한다(호출자가 잊을 수 없다).
 *     meta.mjs 의 런타임 토큰이 최종 백스톱이지만, 호출 지점도 옳아야 한다.
 *
 * 모든 외부 의존은 주입된다: `deps = {meta, host, transition, flush, getPost, now, sleep,
 * notifier, render}`. 주입된 `meta` 는 **실제 모듈과 같은 시그니처**를 쓴다
 * (`fn(token, args, {fetchImpl, cfg})`) — 스텁과 실물이 교환 가능해야 테스트가 의미를 갖는다.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadConfig, flush as libFlush, transition as libTransition, getPost as libGetPost,
  loadIndex, canTransition, classifyHeld, idemMarker as libIdemMarker,
  normalizeCaption, sha256, workDir,
} from './lib.mjs';
import * as metaModule from './meta.mjs';
import * as hostModule from './host.mjs';
import { makeLogger } from '../lib/log.mjs';

const log = makeLogger('cardnews/publish');

/**
 * resume 가능한 상태 = sweep 대상 상태(held 제외). 이 두 집합이 어긋나면 sweep 이 집어온
 * 포스트를 `publishPost` 가 처리하지 못한다 — §7.3 시나리오 18이 그 일치를 강제한다.
 */
export const RESUMABLE_STATES = Object.freeze([
  'rendered', 'hosted', 'child_containers_partial', 'carousel_container_created', 'publish_unknown',
]);
/** sweep 대상 = 위 5개 + `held(transient, <24h)`. 6번째는 상태가 아니라 조건부라 따로 둔다. */
export const SWEEP_STATES = RESUMABLE_STATES;

const DAY_MS = 86400000;
const DEFAULTS = Object.freeze({
  container_ttl_ms: 72000000,     // 20h
  reconcile_delay_ms: 45000,
  reconcile_lookback_ms: 1800000, // 30분 — since·ambiguity guard **양쪽**에 적용
  stale_publish_unknown_days: 7,
  max_confirmed_failed_republish: 1,
  max_publish_issued: 3,
  child_retry_max: 3,
  child_retry_base_ms: 2000,
});

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const ms = (d) => (d instanceof Date ? d.getTime() : Number(d));
const iso = (d) => new Date(ms(d)).toISOString();

// ── 실행 컨텍스트 ────────────────────────────────────────────────────────────

/**
 * 주입 지점을 한 곳에 모은다. 기본값은 실제 모듈이고, 테스트는 `deps` 로 갈아끼운다.
 * 이미 만들어진 ctx 를 다시 주면 그대로 돌려준다(내부 재귀 호출이 컨텍스트를 잃지 않게).
 */
export function makeCtx(opts = {}) {
  if (opts.__cardnewsCtx) return opts;
  if (opts.ctx?.__cardnewsCtx) return opts.ctx;
  const { cfg, token = null, deps = {}, fetchImpl, now } = opts;
  const conf = cfg || loadConfig();
  const meta = deps.meta || metaModule;
  const host = deps.host || hostModule;
  const clock = deps.now || now || (() => new Date());
  const ctx = {
    __cardnewsCtx: true,
    cfg: conf,
    token,
    meta,
    host,
    fetchImpl: fetchImpl || deps.fetchImpl,
    // meta.mjs 함수들의 3번째 인자 — 스텁도 같은 모양을 받는다.
    mo: { fetchImpl: fetchImpl || deps.fetchImpl, cfg: conf },
    transition: deps.transition || libTransition,
    flush: deps.flush || libFlush,
    getPost: deps.getPost || libGetPost,
    render: deps.render || defaultRerender,
    sleep: deps.sleep || ((n) => new Promise(r => setTimeout(r, n))),
    notifier: deps.notifier || null,
    now: () => new Date(ms(clock()) || Date.now()),
  };
  return ctx;
}

/**
 * 경보는 **베스트에포트**다 — 알림 실패가 상태 머신을 죽이면 안 된다(경보가 없어서 못 고친
 * 것보다 상태가 깨져서 중복 발행하는 쪽이 훨씬 비싸다). 다만 조용히 넘기지 않고 warn 을 남긴다.
 * `deps.notifier` 미주입이면 로그만 — 실제 채널 배선(§3.19 EVENTS 3종)은 관제 통합 몫이다.
 */
async function alert(ctx, event, payload = {}) {
  try {
    if (typeof ctx.notifier === 'function') {
      const r = await ctx.notifier(event, payload);
      // R11/F2: mock 게이트에 삼켜졌는지를 표면화한다("보냈다"고 믿는 것이 가장 흔한 거짓 green).
      const delivered = !r || Object.values(r).some(v => v === 'sent' || v === true);
      if (!delivered) log.warn(`경보 미전송(${event}): ${JSON.stringify(r)}`);
      return { ok: true, delivered, result: r };
    }
    log.warn(`[경보:${event}] ${JSON.stringify(payload)}`);
    return { ok: true, delivered: false, result: null };
  } catch (e) {
    log.warn(`경보 발송 실패(비차단, ${event}): ${e.message}`);
    return { ok: false, delivered: false, reason: e.message };
  }
}

// ── 재사용 술어 3개 (§3.14.1) ────────────────────────────────────────────────

/**
 * ① 슬롯 유효성 — **인덱스별로** 적용한다. 전부-아니면-전무가 아니다.
 * 네 조건이 전부 참일 때만 그 자식 컨테이너를 재사용한다: 존재 · 나이<TTL(20h) ·
 * 저장 sha 가 지금 산출물과 동일 · 저장 URL 이 지금 URL 과 동일.
 * 뒤의 두 조건이 있어야 "재렌더로 내용이 바뀐 슬롯"이 조용히 재사용되지 않는다.
 */
export function slotValid(post, i, freshSha, freshUrls, now, cfg) {
  const ttl = num(cfg?.meta?.container_ttl_ms, DEFAULTS.container_ttl_ms);
  const ids = post?.child_container_ids || [];
  const created = post?.child_created_at || [];
  if (!ids[i]) return false;
  const t = Date.parse(created[i] ?? '');
  if (!Number.isFinite(t)) return false;
  if ((ms(now) - t) >= ttl) return false;
  if ((post?.slide_sha256 || [])[i] !== (freshSha || [])[i]) return false;
  if ((post?.public_url || [])[i] !== (freshUrls || [])[i]) return false;
  return true;
}

/** ② 완결성 — **캐러셀 진입 조건일 뿐**, 재사용의 전제가 아니다(§3.14.1). */
export function complete(post, cfg) {
  const n = num(cfg?.cards?.count, 7);
  return (post?.child_container_ids || []).filter(Boolean).length === n;
}

/** ③ 캐러셀 유효성 — 자식 조합이 바뀌면(`children_key`) 캐러셀도 무효다. */
export function carouselValid(post, now, cfg) {
  const ttl = num(cfg?.meta?.container_ttl_ms, DEFAULTS.container_ttl_ms);
  if (!post?.carousel_container_id) return false;
  const t = Date.parse(post.carousel_created_at ?? '');
  if (!Number.isFinite(t)) return false;
  if ((ms(now) - t) >= ttl) return false;
  return post.carousel_children_key === (post.child_container_ids || []).join(',');
}

// ── resume 시 재렌더하지 않는다 (§3.14.2) ────────────────────────────────────

/** 전면 재렌더 기본 구현 — `script.json` 로드 → renderCards → hostSlides. */
async function defaultRerender(post, { cfg, ctx, attemptId }) {
  const scriptPath = join(workDir(post.post_id), 'script.json');
  if (!existsSync(scriptPath)) return { ok: false, reason: `script.json 없음: ${scriptPath}` };
  let script;
  try { script = JSON.parse(readFileSync(scriptPath, 'utf8')); }
  catch (e) { return { ok: false, reason: `script.json 파싱 실패: ${e.message}` }; }
  // playwright 체인은 여기서만 필요하다 — 상태 머신 import 가 브라우저를 끌고 오지 않게 지연 로드.
  const { renderCards } = await import('./render.mjs');
  const dir = workDir(post.post_id, attemptId);
  const r = await renderCards(script, { dir, cfg });
  if (!r.ok) return { ok: false, reason: `render: ${r.reason || '실패'}` };
  const h = await ctx.host.hostSlides(r.files, r.sha256, {
    postId: post.post_id, cfg, now: ctx.now(), fetchImpl: ctx.fetchImpl,
  });
  if (!h.ok) return { ok: false, reason: `host: ${h.reason}` };
  return { ok: true, sha: r.sha256, urls: h.urls, files: r.files };
}

/**
 * resume 진입 시 **재렌더 여부**를 정한다(§3.14.2).
 *
 * 🔴 `verifyStored` 는 URL↔sha **교차검증**이다 — post 자신의 필드끼리 비교하면 항상 참이라
 * 아무것도 증명하지 못한다(§7.3 시나리오 5′). URL 에 박힌 sha 앞 16자와 sha 배열이 맞고,
 * 그 URL 이 지금도 열려야만 재렌더를 건너뛴다.
 *
 * @returns {{ok:true, sha:string[], urls:string[], rerendered:boolean, attemptId?:string}
 *          |{ok:false, heldReason:string, reason:string}}
 */
export async function resolveArtifacts(post, opts = {}) {
  const ctx = makeCtx(opts);
  const cfg = ctx.cfg;
  const n = num(cfg?.cards?.count, 7);

  if (RESUMABLE_STATES.includes(post.status)
      && (post.public_url || []).length === n && (post.slide_sha256 || []).length === n) {
    const v = await ctx.host.verifyStored(post.public_url, post.slide_sha256, {
      cfg, fetchImpl: ctx.fetchImpl,
    });
    if (v.ok) return { ok: true, sha: post.slide_sha256, urls: post.public_url, rerendered: false };
    log.warn(`저장 산출물 검증 실패(${v.reason}) → 전면 재렌더 [${post.post_id}]`);
  }

  // 전면 재렌더 — **이때만** attempt 가 올라간다(§5.1 attempt_id 규칙).
  const attemptId = nextAttemptId(post);
  const r = await ctx.render(post, { cfg, ctx, attemptId });
  if (!r.ok) return { ok: false, heldReason: 'host:verify-failed', reason: r.reason };
  return { ok: true, sha: r.sha, urls: r.urls, rerendered: true, attemptId, files: r.files };
}

function nextAttemptId(post) {
  const m = /^att-(\d+)$/.exec(String(post?.attempt_id || 'att-1'));
  return `att-${(m ? Number(m[1]) : 1) + 1}`;
}

// ── held 헬퍼 ────────────────────────────────────────────────────────────────

/**
 * held 로 내려간다. 상태가 이미 `held` 면 전이표상 갈 곳이 없으므로 **같은 상태 영속화**
 * (`flush`)로 사유만 갱신한다 — 여기서 transition 을 고집하면 sweep 이 held 를 재시도하다
 * 실패했을 때 상태 머신이 통째로 throw 한다.
 */
async function held(ctx, post, reason, { diag = null, event = null, payload = {} } = {}) {
  const id = post.post_id;
  const cur = ctx.getPost(id) || post;
  const heldClass = classifyHeld(reason, diag);
  try {
    if (cur.status === 'held') {
      ctx.flush(id, { held_reason: reason, held_class: heldClass, held_diag: diag });
    } else if (canTransition(cur.status, 'held').ok) {
      ctx.transition(id, 'held', { held_reason: reason, held_class: heldClass, held_diag: diag });
    } else {
      // published 등 held 로 갈 수 없는 상태 — 상태를 뒤엎지 않고 사실만 남긴다.
      log.error(`held 불가 상태(${cur.status})에서 held 요청: ${reason} [${id}]`);
      return { ok: false, held: reason, held_class: heldClass, state: cur.status };
    }
  } catch (e) {
    log.error(`held 기록 실패(${reason}): ${e.message} [${id}]`);
    return { ok: false, held: reason, held_class: heldClass, error: e.message };
  }
  if (reason.startsWith('meta:token-expired')) {
    await alert(ctx, 'CARDNEWS_TOKEN_EXPIRED', { post_id: id, reason, ...payload });
  } else if (event) {
    await alert(ctx, event, { post_id: id, reason, ...payload });
  }
  log.warn(`held(${heldClass}): ${reason} [${id}]`);
  return { ok: false, held: reason, held_class: heldClass, state: 'held' };
}

// ── 백오프 ───────────────────────────────────────────────────────────────────

/**
 * 자식 컨테이너 생성용 재시도(기본 3회, 2s/4s). R2 의 CDN 전파 지연이 실재해서 필요하다.
 * 단, `token-expired`·`permission` 은 **재시도해도 절대 낫지 않으므로** 즉시 포기한다(§3.13.2).
 */
async function withBackoff(fn, { max, baseMs, sleep }) {
  let last = null;
  for (let a = 1; a <= max; a++) {
    last = await fn();
    if (last?.ok) return { ...last, attempts: a };
    if (['token-expired', 'permission'].includes(last?.error)) return { ...last, attempts: a };
    if (a < max) await sleep(baseMs * (2 ** (a - 1)));
  }
  return { ...(last || { ok: false, reason: '무응답' }), attempts: max };
}

// ── 주 절차 (§3.14.3) ────────────────────────────────────────────────────────

/**
 * 포스트 1건을 발행 가능한 지점까지 밀어붙인다. **어느 상태로 진입해도 throw 하지 않는다.**
 *
 * ⚠ 계획 §3.14.3 은 step 0(가드) → step 1(getPost) 순이지만, 여기서는 post 를 먼저 읽고
 * `published` 를 먼저 반환한다. 이유는 두 가지다: (a) held 를 기록하려면 post 가 있어야
 * 하는데 가드 실패가 post 부재보다 먼저 오면 기록할 곳이 없다, (b) 이미 발행된 포스트에
 * `held` 를 시도하면 종단 상태 위반으로 throw 한다. getPost 는 네트워크를 타지 않으므로
 * "가드 전에는 Meta 를 건드리지 않는다"는 성질은 그대로다(§7.3 시나리오 12/16/17).
 */
export async function publishPost(postId, opts = {}) {
  const ctx = makeCtx(opts);
  const cfg = ctx.cfg;
  const cards = num(cfg?.cards?.count, 7);

  let post = ctx.getPost(postId);
  if (!post) return { ok: false, reason: 'post-not-found', post_id: postId };
  if (post.status === 'published') {
    return { ok: true, mediaId: post.published_media_id, already: true, post_id: postId };
  }
  // 아직 렌더 전(planned·scripted·null)인 포스트는 발행 대상이 아니다 — 여기서 억지로
  // 밀어붙이면 전이표에 없는 간선(planned → hosted 등)을 만들려다 상태가 뒤엉킨다.
  if (!RESUMABLE_STATES.includes(post.status) && post.status !== 'held') {
    return { ok: false, reason: `not-publishable:${post.status}`, post_id: postId };
  }

  // ── step 0. 🔴 초크포인트 — 여기를 통과하지 못하면 Meta 호출은 한 번도 일어나지 않는다.
  const g = usableGuard(opts.g) ? opts.g : await ctx.meta.guardPublish(cfg, ctx.token, ctx.mo);
  if (!g.ok) return held(ctx, post, `${g.gate}:${g.reason}`);

  // ── step 1. publish_unknown 은 **재발행이 아니라 확인**부터다.
  if (post.status === 'publish_unknown') return reconcile(post, g, ctx);

  let sha, urls;
  /**
   * 🔴 슬롯 재사용 판정의 기준선 — **덮어쓰기 전의** 산출물 필드다.
   * step 3 이 새 sha·URL 을 post 에 flush 한 뒤 그 post 로 `slotValid` 를 부르면 저장값과
   * 비교값이 같은 객체가 되어 **항상 참**이 된다(verifyStored 의 자기참조 함정과 같은 모양).
   * 그러면 전면 재렌더로 그림이 바뀌어도 예전 컨테이너를 그대로 재사용해 **엉뚱한 이미지가
   * 발행된다.** 그래서 진입 시점 스냅샷을 남겨 "그 컨테이너가 무엇으로 만들어졌는지"와
   * "지금 올릴 것"을 비교한다.
   */
  const prior = {
    child_container_ids: [...(post.child_container_ids || [])],
    child_created_at: [...(post.child_created_at || [])],
    slide_sha256: [...(post.slide_sha256 || [])],
    public_url: [...(post.public_url || [])],
  };

  if (post.status === 'held') {
    // ── step 2. held 재활성화 — transient + 산출물 생존, 두 조건 다일 때만.
    if (post.held_class !== 'transient') return { ok: false, reason: 'held:permanent', post_id: postId };
    const v = await ctx.host.verifyStored(post.public_url, post.slide_sha256, { cfg, fetchImpl: ctx.fetchImpl });
    if (!v.ok) {
      // 산출물이 사라졌으면 여기서 되살리지 않는다. 익일 백로그가 **새 post_id** 로 다시
      // 잡는 것이 유일한 회복 경로다(§5.2) — 두 번째 회복 경로를 만들면 둘이 어긋난다.
      return { ok: false, reason: 'held:artifacts-gone', detail: v.reason, post_id: postId };
    }
    post = ctx.transition(postId, 'hosted', {
      held_reason: null, held_class: null, held_diag: null, revived_at: iso(ctx.now()),
    });
    sha = post.slide_sha256;
    urls = post.public_url;
  } else {
    // ── step 3. 산출물 확보(가능하면 재렌더 없이).
    const ra = await resolveArtifacts(post, { ctx });
    if (!ra.ok) return held(ctx, post, ra.heldReason, { diag: { kind: 'artifacts', evidence: ra.reason } });
    sha = ra.sha; urls = ra.urls;

    const patch = { slide_sha256: sha, public_url: urls };
    if (ra.rerendered) { patch.attempt_id = ra.attemptId; patch.hosted_at = iso(ctx.now()); }
    // 🔴 여기가 flush/transition 분기다. `rendered → hosted` 는 정당한 간선이라 전이하고,
    //    그 밖(hosted·child_containers_partial·carousel_container_created)은 **같은 상태
    //    영속화**라 flush 다. 무조건 transition('hosted') 를 부르면 resume 진입이 전부 죽는다.
    post = canTransition(post.status, 'hosted').ok
      ? ctx.transition(postId, 'hosted', patch)
      : ctx.flush(postId, patch);
  }

  // ── step 4. 자식 컨테이너 — **슬롯 단위** 재사용.
  const ids = [...(post.child_container_ids || [])];
  const created = [...(post.child_created_at || [])];
  while (ids.length < cards) ids.push(null);
  while (created.length < cards) created.push(null);

  const retryMax = num(cfg?.meta?.child_retry?.max, DEFAULTS.child_retry_max);
  const retryBase = num(cfg?.meta?.child_retry?.base_ms, DEFAULTS.child_retry_base_ms);

  for (let i = 0; i < cards; i++) {
    if (slotValid(prior, i, sha, urls, ctx.now(), cfg)) continue;
    // 만료·불일치 슬롯은 버린다(그 컨테이너로 발행하면 실패한다).
    ids[i] = null; created[i] = null;

    const r = await withBackoff(
      () => ctx.meta.createChildContainer(ctx.token, { imageUrl: urls[i] }, ctx.mo),
      { max: retryMax, baseMs: retryBase, sleep: ctx.sleep },
    );
    if (!r.ok) {
      // 부분 결과는 다음 런의 자산이다 — 먼저 남기고, 상태를 부분완료로 표시한 뒤 held.
      post = ctx.flush(postId, { child_container_ids: ids, child_created_at: created });
      if (post.status !== 'child_containers_partial'
          && canTransition(post.status, 'child_containers_partial').ok) {
        post = ctx.transition(postId, 'child_containers_partial', {});
      }
      const kind = r.error || ctx.meta.classifyMetaError?.(r.status, r.body) || 'unknown';
      return held(ctx, post, `meta:${kind}`, {
        diag: { kind, evidence: r.reason ?? null, attempts: r.attempts ?? null, slot: i },
      });
    }
    ids[i] = r.containerId;
    created[i] = r.createdAt;

    const patch = { child_container_ids: ids, child_created_at: created };
    // `hosted → child_containers_partial` 은 정당한 간선. `carousel_container_created` 에서
    // 자식을 다시 만들었다면 캐러셀은 이미 무효이므로 §5.2 의 "자식루프 복귀" 간선을 탄다.
    post = (post.status === 'hosted' || post.status === 'carousel_container_created')
      ? ctx.transition(postId, 'child_containers_partial', patch)
      : ctx.flush(postId, patch);
  }

  // ── step 5. 완결성 — 캐러셀 진입 조건.
  if (!complete(post, cfg)) return held(ctx, post, 'child:incomplete');
  // 슬롯을 하나도 새로 만들지 않았다면(전부 재사용) 상태가 `hosted` 에 머무를 수 있다.
  // 그대로 캐러셀로 가면 `hosted → carousel_container_created` 라는 없는 간선을 만들려다
  // throw 한다 — 자식이 전부 있다는 사실을 먼저 상태로 반영하고 넘어간다.
  if (post.status === 'hosted') post = ctx.transition(postId, 'child_containers_partial', {});

  // ── step 6. 캐러셀 컨테이너 + 매칭키 write-ahead.
  if (!carouselValid(post, ctx.now(), cfg)) {
    const caption = post.caption || '';
    const r = await ctx.meta.createCarouselContainer(
      ctx.token, { childIds: post.child_container_ids, caption }, ctx.mo,
    );
    if (!r.ok) {
      const kind = r.error || ctx.meta.classifyMetaError?.(r.status, r.body) || 'unknown';
      return held(ctx, post, `meta:${kind}`, { diag: { kind, evidence: r.reason ?? null, stage: 'carousel' } });
    }
    // 🔴 매칭키는 발행 **전에** 디스크에 남아야 한다. 발행 결과가 불확실해질 때
    //    reconciliation 이 쓸 수 있는 유일한 단서라, 나중에 적으면 이미 늦다.
    post = ctx.transition(postId, 'carousel_container_created', {
      carousel_container_id: r.containerId,
      carousel_created_at: r.createdAt,
      carousel_children_key: r.childrenKey ?? (post.child_container_ids || []).join(','),
      caption_sha256: sha256(normalizeCaption(caption).slice(0, 200)),
      idem_marker: post.idem_marker || libIdemMarker(postId),
    });
  }

  // ── step 7. 유일한 발행 지점.
  return issuePublish(post, g, ctx);
}

// ── 유일한 발행 지점 (§3.14.6) ───────────────────────────────────────────────

/** 가드가 아직 쓸 수 있는가 — 1회용이라 소비된 토큰은 재사용할 수 없다. */
function usableGuard(g) {
  return Boolean(g && g.ok && g.guardToken && !g.__spent);
}

/**
 * `mediaPublish` 를 부르는 **유일한 함수**. 가드를 못 받았으면 스스로 발급한다 —
 * 호출자가 잊는 것이 불가능해야 한다(§3.13.1 ③층).
 */
export async function issuePublish(post, g, ctxIn, opts = {}) {
  const ctx = makeCtx(ctxIn || opts);
  const cfg = ctx.cfg;
  const id = post.post_id;

  const gg = usableGuard(g) ? g : await ctx.meta.guardPublish(cfg, ctx.token, ctx.mo);
  if (!gg.ok) return held(ctx, post, `${gg.gate}:${gg.reason}`);

  const cur = ctx.getPost(id) || post;
  const issued = num(cur.publish_issued_count, 0);
  if (issued >= num(cfg?.meta?.max_publish_issued, DEFAULTS.max_publish_issued)) {
    return held(ctx, cur, 'publish:issue-cap');
  }

  // write-ahead: "쐈다"를 쏘기 전에 적는다. 여기서 죽어도 다음 런은 publish_unknown 을 보고
  // 재시도가 아니라 **확인**부터 한다.
  const now = ctx.now();
  let next = cur;
  const wa = {
    publish_requested_at: iso(now),
    reconcile_after: iso(ms(now) + num(cfg?.meta?.reconcile_delay_ms, DEFAULTS.reconcile_delay_ms)),
    publish_issued_count: issued + 1,
  };
  next = cur.status === 'publish_unknown' ? ctx.flush(id, wa) : ctx.transition(id, 'publish_unknown', wa);

  const r = await ctx.meta.mediaPublish(
    ctx.token, { creationId: next.carousel_container_id, guardToken: gg.guardToken }, ctx.mo,
  );
  gg.__spent = true;  // 1회용 토큰은 소비됐다 — 다음 발행은 새 가드를 받아야 한다.

  if (r.ok) {
    const pub = ctx.transition(id, 'published', {
      published_media_id: r.mediaId, published_at: iso(ctx.now()),
    });
    if (cfg?.meta?.liveness_check) await confirmLive(ctx, pub, r.mediaId);
    return { ok: true, mediaId: r.mediaId, post_id: id };
  }
  // 4xx 도 "안 나갔다"의 증거가 아니다(요청은 도달했을 수 있다) → 확인 후에만 판단.
  if (r.outcome === 'rejected') return reconcile(next, gg, ctx);

  // unknown = 타임아웃·5xx·네트워크. 🔴 재시도하지 않는다.
  await alert(ctx, 'CARDNEWS_PUBLISH_UNKNOWN', { post_id: id, reason: r.reason ?? null, stage: 'issue' });
  return { ok: false, state: 'publish_unknown', reason: r.reason ?? 'unknown', post_id: id };
}

/**
 * 발행 성공이 게시물 노출을 뜻하지 않는다(withheld 가능). **확인만 하고 상태는 안 바꾼다** —
 * 여기서 published 를 되돌리면 그거야말로 중복 발행의 문이 된다.
 */
async function confirmLive(ctx, post, mediaId) {
  const m = await ctx.meta.getMedia(ctx.token, { mediaId }, ctx.mo);
  if (!m.ok) {
    ctx.flush(post.post_id, { liveness: 'unconfirmed', liveness_note: m.reason ?? null });
    await alert(ctx, 'CARDNEWS_PUBLISH_UNKNOWN', { post_id: post.post_id, media_id: mediaId, liveness: 'unconfirmed' });
    return { ok: false };
  }
  ctx.flush(post.post_id, { liveness: 'confirmed', permalink: m.permalink ?? null, liveness_note: null });
  return { ok: true };
}

// ── reconciliation (§3.14.4) ─────────────────────────────────────────────────

/**
 * "쐈는데 결과를 모른다"를 사실로 바꾼다. 재발행은 **미발행이 확정된 경우 하나뿐**이다.
 *
 * 매칭 창은 양쪽 다 스큐를 준다: `since = 요청 - 30분`(우리 시계가 빠를 수 있다),
 * `newerTs = 요청 + 30분`(느릴 수 있다). 한쪽만 주면 경계 근처에서 "우리 것"을 못 보고
 * 미발행으로 오판해 재발행 = 중복 게시가 된다.
 */
export async function reconcile(postOrId, g, ctxIn, opts = {}) {
  const ctx = makeCtx(ctxIn || opts);
  const cfg = ctx.cfg;
  const id = typeof postOrId === 'string' ? postOrId : postOrId.post_id;
  let post = ctx.getPost(id) || (typeof postOrId === 'object' ? postOrId : null);
  if (!post) return { ok: false, reason: 'post-not-found', post_id: id };
  if (post.status === 'published') return { ok: true, mediaId: post.published_media_id, already: true, post_id: id };

  // 진입점 무관 — 가드 통과를 보장한다(sweep 이 여기로 직행할 수 있다).
  const gg = usableGuard(g) ? g : await ctx.meta.guardPublish(cfg, ctx.token, ctx.mo);
  if (!gg.ok) return held(ctx, post, `${gg.gate}:${gg.reason}`);

  // 유계 에스컬레이션 — 영원히 publish_unknown 으로 남는 포스트를 만들지 않는다.
  const staleMs = num(cfg?.meta?.stale_publish_unknown_days, DEFAULTS.stale_publish_unknown_days) * DAY_MS;
  if (postAge(post, ctx.now()) > staleMs) {
    return held(ctx, post, 'reconcile:stale', { event: 'CARDNEWS_PUBLISH_UNKNOWN', payload: { stage: 'stale' } });
  }

  // IG 인덱싱 지연 흡수 — 너무 일찍 물어보면 "없다"는 답이 거짓이 된다.
  const after = Date.parse(post.reconcile_after ?? '');
  if (Number.isFinite(after)) {
    const wait = after - ms(ctx.now());
    if (wait > 0) await ctx.sleep(wait);
  }

  const lookback = num(cfg?.meta?.reconcile_lookback_ms, DEFAULTS.reconcile_lookback_ms);
  const req = Date.parse(post.publish_requested_at ?? '');
  const base = Number.isFinite(req) ? req : ms(ctx.now());
  const r = await ctx.meta.findPublished(ctx.token, {
    idemMarker: post.idem_marker,
    captionSha: post.caption_sha256,
    since: iso(base - lookback),
    newerTs: iso(base + lookback),
  }, ctx.mo);

  if (!r.ok) {
    // 판단 불가 — 상태를 그대로 두고 사람에게 넘긴다. 여기서 추측하면 중복이 된다.
    await alert(ctx, 'CARDNEWS_PUBLISH_UNKNOWN', { post_id: id, reason: r.reason ?? null, stage: 'reconcile-failed' });
    return { ok: false, state: post.status, reason: r.reason ?? 'reconcile-failed', post_id: id };
  }

  if (r.mediaId) {
    const pub = ctx.transition(id, 'published', {
      published_media_id: r.mediaId, published_at: iso(ctx.now()), reconciled: true,
    });
    if (cfg?.meta?.liveness_check) await confirmLive(ctx, pub, r.mediaId);
    return { ok: true, mediaId: r.mediaId, reconciled: true, matchedBy: r.matchedBy ?? null, post_id: id };
  }

  if (r.ambiguous) {
    // 우리 요청보다 **뒤에** 생긴 미디어가 있는데 매칭은 안 된다 = 우리 것일 수도 있다.
    // 재발행하면 중복이므로 하지 않는다. 사람이 본다.
    return held(ctx, post, 'reconcile:ambiguous', { event: 'CARDNEWS_PUBLISH_UNKNOWN', payload: { stage: 'ambiguous' } });
  }

  // 🔴 확정 미발행 — 재발행이 **증명 가능하게** 안전한 유일한 경우.
  const failed = num(post.publish_confirmed_failed_count, 0);
  if (failed >= num(cfg?.meta?.max_confirmed_failed_republish, DEFAULTS.max_confirmed_failed_republish)) {
    return held(ctx, post, 'publish:retry-exhausted');
  }
  post = ctx.flush(id, { publish_confirmed_failed_count: failed + 1 });
  return issuePublish(post, gg, ctx);
}

/** 포스트 나이 — 발행 요청 시각이 있으면 그것, 없으면 시도 시작 시각. */
function postAge(post, now) {
  const t = Date.parse(post?.publish_requested_at ?? '') || Date.parse(post?.attempt_started_at ?? '');
  return Number.isFinite(t) ? (ms(now) - t) : 0;
}

// ── startup sweep (§3.14.5) ──────────────────────────────────────────────────

/**
 * 어제 끝맺지 못한 포스트를 오늘 마무리한다.
 *
 * 이게 없으면 AC-15 는 유닛테스트에서만 통과하고 운영에서 실패한다: `postIdFor` 가 KST 날짜를
 * 박으므로 어제 `publish_unknown` 으로 끝난 포스트는 **오늘 조회되지 않는다**(오늘의 pick 은
 * 다른 post_id 를 만든다). 그 포스트는 아무도 다시 보지 않는 채 인덱스에 남는다.
 *
 * 🔴 step 0 에서 **자기 가드를 받는다** — `reconcile` 은 재발행할 수 있으므로 sweep 이
 * 초크포인트를 통과하지 않은 채 그리로 내려가면 안 된다. 가드가 막히면 Meta 호출은 0회다.
 */
export async function sweepUnresolved(opts = {}) {
  const ctx = makeCtx(opts);
  const cfg = ctx.cfg;
  const cap = num(opts.cap, 5);

  // ── step 0. 🔴 초크포인트
  const g = usableGuard(opts.g) ? opts.g : await ctx.meta.guardPublish(cfg, ctx.token, ctx.mo);
  if (!g.ok) {
    log.warn(`sweep 생략(${g.gate}): ${g.reason}`);
    return { skipped: g.gate, reason: g.reason, swept: [], resolved: 0, held: 0, published: 0 };
  }

  const now = ctx.now();
  const targets = selectSweepTargets(loadIndex(), now, cfg);
  const picked = targets.slice(0, cap);

  const out = { skipped: null, swept: [], resolved: 0, held: 0, published: 0, results: [] };
  const staleMs = num(cfg?.meta?.stale_publish_unknown_days, DEFAULTS.stale_publish_unknown_days) * DAY_MS;

  for (const t of picked) {
    out.swept.push(t.post_id);
    let r;
    if (postAge(t, now) > staleMs) {
      r = await held(ctx, t, 'reconcile:stale', { event: 'CARDNEWS_PUBLISH_UNKNOWN', payload: { stage: 'sweep-stale' } });
    } else if (t.status === 'publish_unknown') {
      r = await reconcile(t, g, ctx);
    } else {
      // held 는 publishPost step 2 가 처리한다(transient + 산출물 생존일 때만 되살아난다).
      r = await publishPost(t.post_id, { ctx, g });
    }
    out.results.push({ post_id: t.post_id, from: t.status, ...r });
    if (r.ok && r.mediaId) { out.published++; out.resolved++; }
    else if (r.held) out.held++;
  }
  return out;
}

/**
 * sweep 대상 선정 — 상태 5종 + `held(transient, <24h)`. 오래된 것부터 처리한다
 * (오래된 `publish_unknown` 일수록 IG 인덱스가 안정돼 매칭이 정확하고, 방치 위험도 크다).
 */
export function selectSweepTargets(idx, now, cfg) {
  const posts = Object.values(idx || {}).filter(p => p && p.post_id);
  const targets = posts.filter((p) => {
    if (RESUMABLE_STATES.includes(p.status)) return true;
    if (p.status === 'held') return p.held_class === 'transient' && postAge(p, now) < DAY_MS;
    return false;
  });
  return targets.sort((a, b) => sortKey(a) - sortKey(b));
}

function sortKey(p) {
  const t = Date.parse(p?.publish_requested_at ?? '') || Date.parse(p?.attempt_started_at ?? '');
  return Number.isFinite(t) ? t : 0;
}
