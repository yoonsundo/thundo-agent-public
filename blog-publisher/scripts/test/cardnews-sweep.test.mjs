#!/usr/bin/env node
/**
 * cardnews-sweep.test.mjs — `sweepUnresolved()` (계획 §3.14.5 · Step 4b)
 *
 * sweep 이 없으면 AC-15 는 **유닛테스트에서만** 통과하고 운영에서 실패한다: `postIdFor` 가 KST
 * 날짜를 박으므로 어제 `publish_unknown` 으로 끝난 포스트는 오늘 조회되지 않는다(오늘의 pick 은
 * 다른 post_id 를 만든다). 그 포스트는 아무도 다시 보지 않는 채 인덱스에 남는다.
 *
 * 증명 대상:
 *  ① 대상 선정 **6상태** — rendered · hosted · child_containers_partial ·
 *    carousel_container_created · publish_unknown · held(transient·24h 내)
 *  ② 대상 아님 — published(종단) · held(permanent/external) · held(transient·24h 초과) · planned
 *  ③ 정렬 — 오래된 것 먼저
 *  ④ 상한 5건/런(폭주 방지)
 *  ⑤ 🔴 가드 차단 시 **Meta 호출 0회**(reconcile 이 재발행할 수 있으므로 sweep 이 step 0 에서
 *    직접 가드를 받는다 — §7.3 시나리오 16·17)
 *  ⑥ 어제 `publish_unknown` 을 오늘 집어 reconcile(§7.3 시나리오 15) · `hosted` 크래시 잔존분
 *    회수(시나리오 25) · 발행 성공 시 `published>0`(시나리오 24 의 전제)
 *
 * 네트워크 없음 · 크리덴셜 없음 · 실제 발행 없음. exit 0 = 전체 통과.
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'cardnews-sweep-'));
process.env.STATE_DIR_OVERRIDE = TMP;      // 실 state/ 격리 — import 전에 세팅
process.env.RUN_MODE = 'mock';
process.env.SUPABASE_URL = 'https://stub.supabase.co';
const CFG_PATH = join(TMP, 'cardnews.json');
writeFileSync(CFG_PATH, JSON.stringify({ schema: 'cardnews/v1', channel: {}, cards: { count: 7 }, meta: {}, publish: { enabled: false } }), 'utf8');
process.env.CARDNEWS_CONFIG_OVERRIDE = CFG_PATH;

const lib = await import('../cardnews/lib.mjs');
const host = await import('../cardnews/host.mjs');
const metaMod = await import('../cardnews/meta.mjs');
const pub = await import('../cardnews/publish.mjs');

let passN = 0, failN = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { console.log(`  [PASS] ${label}`); passN++; }
  else { console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`); failN++; }
};
const eq = (label, got, want) => ok(label, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

// ── 픽스처 ───────────────────────────────────────────────────────────────────

const TOKEN = { ig_user_id: '178414', access_token: 'stub', issued_at: 'x', expires_at: 'y' };
const CFG = () => ({
  channel: {}, cards: { count: 7 },
  host: { bucket: 'cardnews', path_prefix: '', verify_timeout_ms: 1000 },
  publish: { enabled: true },
  meta: {
    container_ttl_ms: 72000000, reconcile_delay_ms: 45000, reconcile_lookback_ms: 1800000,
    recent_media_limit: 25, stale_publish_unknown_days: 7,
    max_confirmed_failed_republish: 1, max_publish_issued: 3,
    child_retry: { max: 3, base_ms: 1 }, liveness_check: false,
  },
});

let CLOCK = new Date('2026-08-02T02:00:00.000Z');     // 오늘(KST 08-02 11:00)
const now = () => CLOCK;
const iso = (d) => new Date(d).toISOString();
const hoursAgo = (h) => iso(CLOCK.getTime() - h * 3600000);

const RES = (status) => ({
  status,
  headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'image/jpeg'
    : String(k).toLowerCase() === 'content-length' ? '500' : null) },
  text: async () => '', json: async () => ({}),
});
const fetchOk = async () => RES(200);

function artifacts(postId) {
  const sha = [], urls = [];
  for (let i = 0; i < 7; i++) {
    const s = lib.sha256(`${postId}#slide${i}`);
    sha.push(s);
    urls.push(host.publicUrl('cardnews', host.objectPath(postId, i, s)));
  }
  return { sha, urls };
}
const fullChildren = (prefix, at) => ({
  child_container_ids: Array.from({ length: 7 }, (_, i) => `${prefix}${i}`),
  child_created_at: Array.from({ length: 7 }, () => at),
});

function makeMeta(opt = {}) {
  const calls = {
    guardPublish: 0, createChildContainer: 0, createCarouselContainer: 0,
    mediaPublish: 0, publishedOk: 0, noGuard: 0, findPublished: 0, getMedia: 0, recentMedia: 0,
  };
  const guards = new Set();
  let gN = 0, cN = 0;
  return {
    calls,
    async guardPublish(cfg, token) {
      calls.guardPublish++;
      const v = opt.guard?.(calls.guardPublish);
      if (v) return v;
      const id = `guard-${++gN}`; guards.add(id);
      return { ok: true, token, limit: { allowed: true }, guardToken: { id, issuedAt: CLOCK.getTime() } };
    },
    async createChildContainer() {
      calls.createChildContainer++;
      return { ok: true, containerId: `child-${++cN}`, createdAt: iso(CLOCK) };
    },
    async createCarouselContainer(token, { childIds }) {
      calls.createCarouselContainer++;
      return { ok: true, containerId: `car-${calls.createCarouselContainer}`, createdAt: iso(CLOCK), childrenKey: (childIds || []).join(',') };
    },
    async mediaPublish(token, { guardToken }) {
      calls.mediaPublish++;
      if (!guardToken || !guards.has(guardToken.id)) { calls.noGuard++; return { ok: false, outcome: 'rejected', reason: 'no-guard' }; }
      guards.delete(guardToken.id);
      const v = opt.publish?.(calls.mediaPublish);
      if (v) { if (v.ok) calls.publishedOk++; return v; }
      calls.publishedOk++;
      return { ok: true, mediaId: `media-${calls.mediaPublish}` };
    },
    async findPublished(token, args) {
      calls.findPublished++; calls.recentMedia++; calls.lastFind = args;
      return opt.find ? opt.find(calls.findPublished, args) : { ok: true, mediaId: `found-${calls.findPublished}`, matchedBy: 'marker' };
    },
    async getMedia(token, { mediaId }) { calls.getMedia++; return { ok: true, mediaId, permalink: 'https://www.instagram.com/p/x/' }; },
    classifyMetaError: metaMod.classifyMetaError,
  };
}

let alerts = [];
const deps = (meta) => ({
  meta, host, now,
  sleep: async () => {},
  notifier: async (ev, p) => { alerts.push({ ev, p }); return { telegram: 'sent', discord: 'sent' }; },
  render: async () => ({ ok: false, reason: 'sweep 테스트에서 재렌더는 일어나면 안 된다' }),
});

const ORDER = ['planned', 'scripted', 'rendered', 'hosted', 'child_containers_partial',
  'carousel_container_created', 'publish_unknown', 'published'];

/** 목표 상태의 포스트를 전이표대로 만든다. `heldReason` 이 있으면 마지막에 held 로 내린다. */
function seed(postId, status, extra = {}, { heldFrom = 'hosted', heldReason = null } = {}) {
  const a = artifacts(postId);
  const base = {
    slide_sha256: a.sha, public_url: a.urls, caption: '캡션',
    attempt_started_at: extra.attempt_started_at || hoursAgo(2),
  };
  const kids = fullChildren('k', extra.child_created_at_iso || hoursAgo(2));
  const fields = { ...base, ...kids, ...extra };
  if (status === 'carousel_container_created' || status === 'publish_unknown') {
    Object.assign(fields, {
      carousel_container_id: 'car-seed', carousel_created_at: extra.child_created_at_iso || hoursAgo(2),
      carousel_children_key: kids.child_container_ids.join(','),
      caption_sha256: lib.sha256(lib.normalizeCaption('캡션').slice(0, 200)),
      idem_marker: lib.idemMarker(postId),
    });
  }
  if (status === 'publish_unknown') {
    Object.assign(fields, {
      publish_requested_at: extra.publish_requested_at || hoursAgo(20),
      reconcile_after: extra.reconcile_after || hoursAgo(19.9),
      publish_issued_count: 1,
    });
  }
  // 자식 컨테이너는 partial 이후 상태에만 존재한다(production 에서 도달 가능한 모양).
  if (status === 'rendered' || status === 'hosted') { delete fields.child_container_ids; delete fields.child_created_at; }

  const stop = heldReason ? heldFrom : status;
  for (const s of ORDER) {
    lib.transition(postId, s, s === stop ? fields : {});
    if (s === stop) break;
  }
  if (heldReason) lib.transition(postId, 'held', { held_reason: heldReason });
  return lib.getPost(postId);
}

const resetIndex = () => { if (existsSync(lib.indexPath())) unlinkSync(lib.indexPath()); };

// ═══ 1. 대상 선정 — 6상태 ════════════════════════════════════════════════════
console.log('\n[1] 대상 선정 — 6상태(+제외 대상)');
{
  resetIndex(); alerts = [];
  const ids = {
    rendered: 'cn-2026-08-01-swrendered',
    hosted: 'cn-2026-08-01-swhosted01',
    partial: 'cn-2026-08-01-swpartial1',
    carousel: 'cn-2026-08-01-swcarousel',
    unknown: 'cn-2026-08-01-swunknown1',
    heldT: 'cn-2026-08-01-swheldtran',
    // ── 제외돼야 하는 것들
    published: 'cn-2026-08-01-swpublishd',
    heldPerm: 'cn-2026-08-01-swheldperm',
    heldOld: 'cn-2026-07-25-swheldold1',
    planned: 'cn-2026-08-02-swplanned1',
  };
  seed(ids.rendered, 'rendered');
  seed(ids.hosted, 'hosted');
  seed(ids.partial, 'child_containers_partial');
  seed(ids.carousel, 'carousel_container_created');
  seed(ids.unknown, 'publish_unknown');
  seed(ids.heldT, 'held', {}, { heldReason: 'meta:media-fetch' });                       // transient · 2h 전
  seed(ids.published, 'published');
  seed(ids.heldPerm, 'held', {}, { heldReason: 'gate:generalization' });                 // permanent
  seed(ids.heldOld, 'held', { attempt_started_at: hoursAgo(30) }, { heldReason: 'meta:media-fetch' }); // transient 지만 30h 전
  lib.transition(ids.planned, 'planned');

  const targets = pub.selectSweepTargets(lib.loadIndex(), CLOCK, CFG()).map(p => p.post_id);
  eq('대상 6건', targets.length, 6);
  const want = [ids.rendered, ids.hosted, ids.partial, ids.carousel, ids.unknown, ids.heldT];
  ok('🔴 6상태 전부 포함', want.every(id => targets.includes(id)), `targets=${targets.join(',')}`);
  ok('published 제외(종단)', !targets.includes(ids.published));
  ok('held(permanent) 제외 — 재시도해도 같은 결과', !targets.includes(ids.heldPerm));
  ok('held(transient, 24h 초과) 제외 — 익일 새 post_id 가 회복 경로', !targets.includes(ids.heldOld));
  ok('planned 제외(아직 산출물 없음)', !targets.includes(ids.planned));

  // 대상 집합이 publishPost 가 처리할 수 있는 집합과 일치하는가(§7.3 시나리오 18 과 한 쌍).
  eq('SWEEP_STATES 가 RESUMABLE_STATES 와 동일 객체', pub.SWEEP_STATES, pub.RESUMABLE_STATES);
  eq('상태 5종 + held 조건부 = 6', pub.SWEEP_STATES.length + 1, 6);
}

// ═══ 2. 정렬 — 오래된 것 먼저 ════════════════════════════════════════════════
console.log('\n[2] 정렬 — 오래된 것 먼저(publish_requested_at ?? attempt_started_at)');
{
  resetIndex();
  seed('cn-2026-08-01-sortnew0001', 'hosted', { attempt_started_at: hoursAgo(1) });
  seed('cn-2026-07-30-sortold0001', 'hosted', { attempt_started_at: hoursAgo(48) });
  seed('cn-2026-08-01-sortmid0001', 'publish_unknown', {
    attempt_started_at: hoursAgo(1), publish_requested_at: hoursAgo(10), reconcile_after: hoursAgo(9.9),
  });
  const order = pub.selectSweepTargets(lib.loadIndex(), CLOCK, CFG()).map(p => p.post_id);
  eq('가장 오래된 것이 먼저', order[0], 'cn-2026-07-30-sortold0001');
  eq('publish_requested_at 이 우선 키', order[1], 'cn-2026-08-01-sortmid0001');
  eq('가장 최근이 마지막', order[2], 'cn-2026-08-01-sortnew0001');
}

// ═══ 3. 상한 5건 ═════════════════════════════════════════════════════════════
console.log('\n[3] 상한 5건/런 — 폭주 방지');
{
  resetIndex(); alerts = [];
  for (let i = 0; i < 8; i++) {
    seed(`cn-2026-08-01-cap${String(i).padStart(7, '0')}`, 'hosted', { attempt_started_at: hoursAgo(20 - i) });
  }
  const meta = makeMeta();
  const r = await pub.sweepUnresolved({ cfg: CFG(), token: TOKEN, deps: deps(meta), fetchImpl: fetchOk });
  eq('8건 중 5건만 훑는다', r.swept.length, 5);
  eq('발행도 5건까지만', meta.calls.mediaPublish, 5);
  ok('가장 오래된 5건이 선택됐다',
    r.swept[0] === 'cn-2026-08-01-cap0000000' && !r.swept.includes('cn-2026-08-01-cap0000005'),
    r.swept.join(','));
  eq('published 집계', r.published, 5);
  // 🔴 가드는 1회용이라 발행 1건당 정확히 1개가 필요하다. sweep step 0 이 받은 것이 첫 발행에
  //    쓰이고, 그 뒤로는 소비될 때마다 새로 받는다 → 발행 5건 = 가드 5개(돌려쓰기 0).
  eq('🔴 발행 1건당 가드 1개', meta.calls.guardPublish, 5);
  eq('no-guard 거부 0건', meta.calls.noGuard, 0);
}

// ═══ 4. 🔴 가드 차단 → Meta 호출 0회 (시나리오 16·17) ════════════════════════
console.log('\n[4] 🔴 가드 차단 시 Meta 호출 0회');
{
  for (const [label, guard] of [
    ['readiness(publish.enabled=false)', () => ({ ok: false, gate: 'readiness', reason: 'publish.enabled=false (무인 발행 차단)' })],
    ['limit(quota 소진)', () => ({ ok: false, gate: 'limit', reason: 'quota 50/50' })],
  ]) {
    resetIndex(); alerts = [];
    seed('cn-2026-07-24-stale00001', 'publish_unknown', {
      attempt_started_at: hoursAgo(9 * 24), publish_requested_at: hoursAgo(9 * 24), reconcile_after: hoursAgo(9 * 24),
    });
    seed('cn-2026-08-01-fresh00001', 'hosted');
    const meta = makeMeta({ guard });
    const r = await pub.sweepUnresolved({ cfg: CFG(), token: TOKEN, deps: deps(meta), fetchImpl: fetchOk });

    eq(`[${label}] skipped 가 게이트를 밝힌다`, r.skipped, guard().gate);
    eq(`[${label}] swept 0건`, r.swept.length, 0);
    eq(`[${label}] published 0`, r.published, 0);
    eq(`[${label}] 🔴 mediaPublish 0회`, meta.calls.mediaPublish, 0);
    eq(`[${label}] 🔴 recentMedia(findPublished) 0회`, meta.calls.recentMedia, 0);
    eq(`[${label}] createChildContainer 0회`, meta.calls.createChildContainer, 0);
    eq(`[${label}] 가드 조회는 딱 1회(런당)`, meta.calls.guardPublish, 1);
    eq(`[${label}] 상태는 손대지 않았다`, lib.getPost('cn-2026-08-01-fresh00001').status, 'hosted');
  }
}

// ═══ 5. 어제 publish_unknown 을 오늘 회수 (시나리오 15) ══════════════════════
console.log('\n[5] 시나리오 15 — 어제 publish_unknown 을 오늘 sweep 이 reconcile');
{
  resetIndex(); alerts = [];
  const P = 'cn-2026-08-01-yesterday1';     // 어제 날짜 post_id — 오늘 pick 은 이 id 를 못 만든다
  seed(P, 'publish_unknown', { attempt_started_at: hoursAgo(23), publish_requested_at: hoursAgo(23), reconcile_after: hoursAgo(22.9) });
  const meta = makeMeta({ find: () => ({ ok: true, mediaId: 'media-yesterday', matchedBy: 'marker' }) });
  const r = await pub.sweepUnresolved({ cfg: CFG(), token: TOKEN, deps: deps(meta), fetchImpl: fetchOk });

  eq('sweep 이 집었다', r.swept[0], P);
  eq('reconcile 1회', meta.calls.findPublished, 1);
  eq('published 로 확정', lib.getPost(P).status, 'published');
  eq('reconciled:true', lib.getPost(P).reconciled, true);
  eq('published_media_id', lib.getPost(P).published_media_id, 'media-yesterday');
  eq('🔴 mediaPublish 0회 — 중복 없음', meta.calls.mediaPublish, 0);
  eq('resolved 집계', r.resolved, 1);
  eq('published 집계 — runDaily 가 이걸 보고 즉시 반환한다(시나리오 24)', r.published, 1);
}

// ═══ 6. hosted 크래시 잔존분 회수 (시나리오 25) ══════════════════════════════
console.log('\n[6] 시나리오 25 — step 3 flush 직후 크래시(hosted)를 다음 런이 집는다');
{
  resetIndex(); alerts = [];
  const P = 'cn-2026-08-01-crashed001';
  seed(P, 'hosted', { attempt_started_at: hoursAgo(12) });
  // 크래시 직후 상태: 산출물은 남았고 자식 컨테이너는 하나도 없다.
  lib.flush(P, { child_container_ids: [], child_created_at: [] });

  const meta = makeMeta();
  const r = await pub.sweepUnresolved({ cfg: CFG(), token: TOKEN, deps: deps(meta), fetchImpl: fetchOk });
  eq('🔴 hosted 를 집는다', r.swept[0], P);
  eq('자식 7개를 만든다', meta.calls.createChildContainer, 7);
  eq('published 도달', lib.getPost(P).status, 'published');
  eq('published 집계', r.published, 1);
}

// ═══ 7. 유계 에스컬레이션 — stale publish_unknown ════════════════════════════
console.log('\n[7] stale publish_unknown(7일 초과) → held(reconcile:stale) + 경보');
{
  resetIndex(); alerts = [];
  const P = 'cn-2026-07-20-stale00001';
  seed(P, 'publish_unknown', {
    attempt_started_at: hoursAgo(9 * 24), publish_requested_at: hoursAgo(9 * 24), reconcile_after: hoursAgo(9 * 24),
  });
  const meta = makeMeta();
  const r = await pub.sweepUnresolved({ cfg: CFG(), token: TOKEN, deps: deps(meta), fetchImpl: fetchOk });

  const p = lib.getPost(P);
  eq('held', p.status, 'held');
  eq('held_reason', p.held_reason, 'reconcile:stale');
  eq('🔴 조회도 발행도 하지 않는다', meta.calls.findPublished + meta.calls.mediaPublish, 0);
  eq('경보 1건', alerts.length, 1);
  eq('held 집계', r.held, 1);
}

// ═══ 8. 혼합 — 한 런에 여러 상태가 섞여도 각자 제 경로로 ═════════════════════
console.log('\n[8] 혼합 런 — publish_unknown 은 reconcile, 나머지는 publishPost');
{
  resetIndex(); alerts = [];
  const U = 'cn-2026-08-01-mixunknown';
  const H = 'cn-2026-08-01-mixhosted1';
  const T = 'cn-2026-08-01-mixheldtr1';
  seed(U, 'publish_unknown', { attempt_started_at: hoursAgo(20), publish_requested_at: hoursAgo(20), reconcile_after: hoursAgo(19.9) });
  seed(H, 'hosted', { attempt_started_at: hoursAgo(10) });
  seed(T, 'held', { attempt_started_at: hoursAgo(5) }, { heldReason: 'meta:media-fetch' });

  const meta = makeMeta({ find: () => ({ ok: true, mediaId: 'media-reconciled', matchedBy: 'marker' }) });
  const r = await pub.sweepUnresolved({ cfg: CFG(), token: TOKEN, deps: deps(meta), fetchImpl: fetchOk });

  eq('3건 훑음', r.swept.length, 3);
  eq('오래된 것부터', r.swept[0], U);
  eq('unknown 은 reconcile 로(발행 아님)', lib.getPost(U).published_media_id, 'media-reconciled');
  eq('hosted 는 발행까지', lib.getPost(H).status, 'published');
  eq('held(transient) 는 되살아나 발행까지', lib.getPost(T).status, 'published');
  ok('되살아난 흔적', Boolean(lib.getPost(T).revived_at));
  eq('실제 발행은 2건(reconcile 된 1건 제외)', meta.calls.mediaPublish, 2);
  eq('published 집계 3(확정 포함)', r.published, 3);
  eq('no-guard 거부 0건 — 소비된 토큰을 돌려쓰지 않았다', meta.calls.noGuard, 0);
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\ncardnews sweep(Step 4b): ${passN} pass / ${failN} fail`);
process.exit(failN === 0 ? 0 : 1);
