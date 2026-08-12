#!/usr/bin/env node
/**
 * curiosity-nogap.test.mjs — US-008 무결방 가드 유닛테스트
 *
 * 검증 대상(2026-07-25/26 이틀 연속 업로드 0편 재발 방지):
 *   (a) 슬롯이 0편으로 끝나면 결방 경보 페이로드가 만들어진다
 *   (b) 같은 날 같은 슬롯 중복 경보는 막히고, 다른 슬롯 실패는 각각 경보된다
 *   (c) claude 제작이 전면 실패해도 재고가 있으면 하루 3편이 채워진다
 *   (d) 이미 3편이면 추가 발행하지 않는다(일일 상한 엄수)
 *   (e) 경보 발송이 throw 해도 슬롯이 죽지 않는다
 *   (f) 재고 부족 판정이 목표치 대비 정확한 보충 필요량을 낸다
 *   (g) 오늘 몫을 다 채운 뒤에만 재고 버퍼를 보충한다(업로드 차단 cfg 로)
 *
 * 네트워크·크리덴셜 불필요(모든 외부 경로 스텁). 실제 state/config 오염 금지 —
 * paths 는 config.mjs import 시점에 확정되므로 env 를 먼저 세팅하고 동적 import 한다.
 * exit 0 = 전체 통과 / 1 = 실패.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'curio-nogap-'));
process.env.STATE_DIR_OVERRIDE = TMP;          // 실 state/ 격리
process.env.RUN_MODE = 'mock';
process.env.CURIOSITY_SLOT_HOURS = '10,12,18';  // 결손 기대치 계산 고정
delete process.env.CURIOSITY_SLOT_N;
delete process.env.CURIOSITY_FORCE;
delete process.env.CURIOSITY_DAILY_CAP;
delete process.env.CURIOSITY_SLOT_KEY;
delete process.env.CURIOSITY_INVENTORY_TARGET;
delete process.env.CURIOSITY_INVENTORY_MAX_REFILL;
delete process.env.CURIOSITY_INVENTORY_REFILL;

const slot = await import('../shorts-curiosity/slot.mjs');
const inventory = await import('../shorts-curiosity/inventory.mjs');
const lib = await import('../shorts-curiosity/lib.mjs');

let passN = 0, failN = 0;
function ok(label, cond, extra = '') {
  if (cond) { console.log(`  [PASS] ${label}`); passN++; }
  else { console.log(`  [FAIL] ${label}${extra ? ` — ${extra}` : ''}`); failN++; }
}
const eq = (label, got, want) => ok(label, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

// ─── 스텁 ─────────────────────────────────────────────────────────────────────

const CFG = {
  enabled: true,
  pick: { best_n: 1 },
  backlog: { target_size: 50 },
  upload: { enabled: true, daily_cap: 3 },
};

/** 업로드 가능 환경(운영과 동일) */
const readyStub = () => ({ ready: true });

/** KST 시각으로 Date 만들기 */
const kst = (s) => new Date(`${s}+09:00`);

/** 오늘(KST) 업로드 n건이 들어있는 index 스텁 */
function indexWithUploads(n, isoAt) {
  const idx = {};
  for (let i = 0; i < n; i++) idx[`up-${i}`] = { status: 'uploaded', at: isoAt, subject: `s${i}`, video: `/nope/${i}.mp4` };
  return idx;
}

/** 알림 스텁 — 호출 기록 + 도달 결과 반환 */
function notifierStub({ throws = false, delivery = { telegram: 'sent', discord: 'sent' } } = {}) {
  const calls = [];
  const fn = async (event, payload) => {
    calls.push({ event, payload });
    if (throws) throw new Error('notify 폭발(스텁)');
    return delivery;
  };
  fn.calls = calls;
  return fn;
}

/** 재고 폴백 스텁 — 요청 편수 기록, min(요청, 보유)편 업로드 성공으로 응답 */
function fallbackStub(stock) {
  const asked = [];
  const fn = async (_cfg, count) => {
    asked.push(count);
    const give = Math.max(0, Math.min(count, stock));
    stock -= give;
    return Array.from({ length: give }, (_, i) => ({ subject: `재고${i}`, youtube: `https://youtube.com/shorts/fb${i}`, from_inventory: true }));
  };
  fn.asked = asked;
  return fn;
}

// ─── (a) 0편 → 결방 경보 페이로드 ────────────────────────────────────────────
console.log('\n(a) 슬롯 0편 → 결방 경보');
{
  const notifier = notifierStub();
  const fb = fallbackStub(0);
  const r = await slot.runSlot({
    cfg: CFG,
    deps: {
      now: kst('2026-07-30T18:05:00'),
      loadIndex: () => ({}),
      uploadReadiness: readyStub,
      runDaily: async () => { throw new Error('claude 실행 실패: Command failed: claude -p'); },
      uploadProducedFallback: fb,
      notifier,
      refillInventory: async () => ({ ok: true, produced: 0 }),
    },
  });
  eq('경보 발송됨', r.alert?.alerted, true);
  eq('도달 확인(sent)', r.alert?.sent, true);
  eq('알림 1회 호출', notifier.calls.length, 1);
  eq('이벤트 = MISSED_RUN', notifier.calls[0]?.event, 'MISSED_RUN');
  ok('사유에 결방·날짜·진행상황', /결방/.test(notifier.calls[0]?.payload?.reason || '') && /2026-07-30/.test(notifier.calls[0]?.payload?.reason || '') && /0\/3/.test(notifier.calls[0]?.payload?.reason || ''), notifier.calls[0]?.payload?.reason);
  ok('상세에 실패 사유 원문', /claude 실행 실패/.test(notifier.calls[0]?.payload?.details || ''), notifier.calls[0]?.payload?.details);
  ok('상세에 재고 잔량·사용량 한도 확인 안내', /재고/.test(notifier.calls[0]?.payload?.details || '') && /사용량 한도/.test(notifier.calls[0]?.payload?.details || ''));
  eq('마지막 슬롯이라 3편 시도', r.slot_n, 3);
  eq('발행 0편', r.today_total, 0);
  eq('실패로 보고', r.ok, false);
  eq('제작 예외 종료코드 2 보존', r.exit, 2);
  ok('마커 생성됨', existsSync(r.alert.marker), r.alert.marker);
}

// ─── (b) 중복 경보 차단 / 다른 슬롯은 각각 경보 ───────────────────────────────
console.log('\n(b) 같은 슬롯 중복 차단 · 다른 슬롯 개별 경보');
{
  const notifier = notifierStub();
  const deps = {
    now: kst('2026-07-30T18:05:00'),
    loadIndex: () => ({}),
    uploadReadiness: readyStub,
    runDaily: async () => { throw new Error('claude 실행 실패(재시도)'); },
    uploadProducedFallback: fallbackStub(0),
    notifier,
    refillInventory: async () => ({ ok: true }),
  };
  const dup = await slot.runSlot({ cfg: CFG, deps });           // (a) 와 같은 날·같은 18시 슬롯
  eq('중복 경보 차단', dup.alert?.skipped, 'slot-marker');
  eq('중복 시 알림 미호출', notifier.calls.length, 0);
  ok('중복이어도 슬롯은 정상 종료(예외 없음)', dup.exit === 2);

  const other = await slot.runSlot({ cfg: CFG, deps: { ...deps, now: kst('2026-07-30T12:05:00') } });
  eq('다른 슬롯(12시)은 경보', other.alert?.alerted, true);
  eq('다른 슬롯 알림 1회', notifier.calls.length, 1);
  ok('12시 슬롯 키가 마커에 반영', /slot12/.test(other.alert.marker), other.alert.marker);
}

// ─── (c) claude 전면 실패 + 재고 → 3편 확보 ──────────────────────────────────
console.log('\n(c) claude 전멸 + 재고 → 하루 3편 확보');
{
  const notifier = notifierStub();
  const fb = fallbackStub(5);
  const r = await slot.runSlot({
    cfg: CFG,
    deps: {
      now: kst('2026-07-31T18:05:00'),
      loadIndex: () => ({}),
      uploadReadiness: readyStub,
      runDaily: async () => { throw new Error('claude 실행 실패: Command failed'); },
      uploadProducedFallback: fb,
      notifier,
      refillInventory: async () => ({ ok: true }),
    },
  });
  eq('재고 폴백 3편 요청', fb.asked[0], 3);
  eq('재고로 3편 업로드', r.fallback_uploads, 3);
  eq('오늘 합계 3편', r.today_total, 3);
  eq('슬롯 성공', r.ok, true);
  eq('종료코드 0', r.exit, 0);
  eq('결방 경보 없음', r.alert, null);
  eq('경보 미발송', notifier.calls.length, 0);
}

// ─── (c-2) 오늘 2/3 + 제작 실패 → 결손 1편만 폴백(상한 준수) ──────────────────
console.log('\n(c-2) 부분 결손은 결손분만 보충');
{
  const fb = fallbackStub(5);
  const r = await slot.runSlot({
    cfg: CFG,
    deps: {
      now: kst('2026-07-31T18:05:00'),
      loadIndex: () => indexWithUploads(2, '2026-07-31T09:00:00Z'),  // = 18:00 KST 07-31
      uploadReadiness: readyStub,
      runDaily: async () => { throw new Error('claude 실행 실패'); },
      uploadProducedFallback: fb,
      notifier: notifierStub(),
      refillInventory: async () => ({ ok: true }),
    },
  });
  eq('이번 슬롯 목표 1편', r.slot_n, 1);
  eq('재고 요청 1편(3편 아님)', fb.asked[0], 1);
  eq('오늘 합계 3편(상한)', r.today_total, 3);
  eq('상한 초과 없음', r.today_total <= 3, true);
}

// ─── (d) 이미 3편 → 아무것도 하지 않음 ───────────────────────────────────────
console.log('\n(d) 일일 상한 도달 시 무발행');
{
  let runCalled = 0, fbCalled = 0;
  const notifier = notifierStub();
  const r = await slot.runSlot({
    cfg: CFG,
    deps: {
      now: kst('2026-08-01T18:05:00'),
      loadIndex: () => indexWithUploads(3, '2026-08-01T09:00:00Z'),
      uploadReadiness: readyStub,
      runDaily: async () => { runCalled++; return { ok: true, youtube: 'x' }; },
      uploadProducedFallback: async () => { fbCalled++; return []; },
      notifier,
      refillInventory: async () => ({ ok: true }),
    },
  });
  eq('스킵 사유 daily_cap', r.skipped, 'daily_cap');
  eq('제작 미호출', runCalled, 0);
  eq('폴백 미호출', fbCalled, 0);
  eq('경보 미발송(상한은 정상)', notifier.calls.length, 0);
  eq('정상 종료', r.ok, true);
}

// ─── (e) 경보 발송 실패가 슬롯을 죽이지 않는다 ───────────────────────────────
console.log('\n(e) 경보 실패 내성');
{
  const notifier = notifierStub({ throws: true });
  const r = await slot.runSlot({
    cfg: CFG,
    deps: {
      now: kst('2026-08-02T18:05:00'),
      loadIndex: () => ({}),
      uploadReadiness: readyStub,
      runDaily: async () => { throw new Error('claude 실행 실패'); },
      uploadProducedFallback: fallbackStub(0),
      notifier,
      refillInventory: async () => ({ ok: true }),
    },
  });
  ok('notify throw 를 흡수', r.alert?.alerted === true && r.alert?.sent === false, JSON.stringify(r.alert));
  eq('슬롯은 결과를 반환(죽지 않음)', typeof r.exit, 'number');

  // 경보 헬퍼 자체가 터지는 최악의 경우도 흡수해야 한다.
  const r2 = await slot.runSlot({
    cfg: CFG,
    deps: {
      now: kst('2026-08-03T18:05:00'),
      loadIndex: () => ({}),
      uploadReadiness: readyStub,
      runDaily: async () => { throw new Error('claude 실행 실패'); },
      uploadProducedFallback: fallbackStub(0),
      alertNoGap: async () => { throw new Error('경보 경로 폭발'); },
      refillInventory: async () => ({ ok: true }),
    },
  });
  eq('alertNoGap 예외도 흡수', r2.alert?.error, '경보 경로 폭발');
  eq('예외 후에도 exit 계약 유지', r2.exit, 2);

  // 도달 실패(크리덴셜 없음 등)는 sent=false 로 정직하게 보고한다.
  const r3 = await slot.alertNoGap({
    notifier: notifierStub({ delivery: { telegram: 'console-fallback', discord: 'mock' } }),
    now: kst('2026-08-04T18:05:00'), already: 0, cap: 3, planned: 3,
  });
  eq('mock/폴백 배달은 sent=false', r3.sent, false);
}

// ─── (f) 재고 부족 판정 ──────────────────────────────────────────────────────
console.log('\n(f) 재고 부족 판정·보충 필요량');
{
  const vdir = join(TMP, 'videos');
  mkdirSync(vdir, { recursive: true });
  const v = (n) => { const p = join(vdir, n); writeFileSync(p, 'x'); return p; };
  const idx = {
    a: { status: 'produced', at: '2026-07-28T00:00:00Z', video: v('a.mp4'), subject: 'A' },
    b: { status: 'produced', at: '2026-07-29T00:00:00Z', video: v('b.mp4'), subject: 'B' },
    gone: { status: 'produced', at: '2026-07-29T00:00:00Z', video: join(vdir, 'missing.mp4'), subject: '파일없음' },
    old: { status: 'produced', at: '2026-07-15T00:00:00Z', video: v('old.mp4'), subject: '개편이전' },
    up: { status: 'uploaded', at: '2026-07-29T00:00:00Z', video: v('up.mp4'), subject: '이미발행' },
    held: { status: 'held', at: '2026-07-29T00:00:00Z', subject: '보류' },
  };
  eq('재고 집계(파일없음·개편이전·업로드분 제외)', inventory.inventoryCount(idx), 2);
  eq('오래된 순 정렬', inventory.inventoryItems(idx)[0].id, 'a');

  const mixedIdx = {
    reveal: { status: 'produced', at: '2026-07-30T00:00:00Z', video: v('reveal.mp4'), subject: '반전 재고', angle: 'reveal' },
    whatif: { status: 'produced', at: '2026-07-30T01:00:00Z', video: v('whatif.mp4'), subject: '가정 재고', angle: 'whatif' },
  };
  const pausedCfg = { ...CFG, backlog: { ...CFG.backlog, angles: { whatif_ratio: 0 } } };
  eq('whatif 하드 중지면 reveal 재고만 업로드 가능', inventory.inventoryCount(mixedIdx, pausedCfg), 1);
  eq('whatif 하드 중지 재고 목록에 reveal만 남음', inventory.inventoryItems(mixedIdx, pausedCfg)[0]?.id, 'reveal');
  const activeCfg = { ...CFG, backlog: { ...CFG.backlog, angles: { whatif_ratio: 0.35 } } };
  eq('whatif 활성 비율이면 혼합 재고 모두 업로드 가능', inventory.inventoryCount(mixedIdx, activeCfg), 2);

  const a1 = inventory.assessInventory({ cfg: CFG, index: idx });
  eq('목표 기본값 3', a1.target, 3);
  eq('부족 1편', a1.deficit, 1);
  eq('보충 요청 1편(슬롯 상한)', a1.refillN, 1);
  eq('부족 판정 true', a1.needsRefill, true);

  process.env.CURIOSITY_INVENTORY_TARGET = '5';
  process.env.CURIOSITY_INVENTORY_MAX_REFILL = '2';
  const a2 = inventory.assessInventory({ cfg: CFG, index: idx });
  eq('목표 5 → 부족 3', a2.deficit, 3);
  eq('슬롯 상한 2 로 절단', a2.refillN, 2);
  const a3 = inventory.assessInventory({ cfg: CFG, index: idx, reserve: 1 });
  eq('예약분 차감(available)', a3.available, 1);
  eq('예약분 반영 부족 4', a3.deficit, 4);
  delete process.env.CURIOSITY_INVENTORY_TARGET;
  delete process.env.CURIOSITY_INVENTORY_MAX_REFILL;

  const a4 = inventory.assessInventory({ cfg: { ...CFG, inventory: { target: 2 } }, index: idx });
  eq('config 키(inventory.target) 반영', a4.target, 2);
  eq('충족 시 보충 0', a4.refillN, 0);

  const a5 = inventory.assessInventory({ cfg: { ...CFG, inventory: { refill_enabled: false } }, index: idx });
  eq('보충 비활성 시 refillN 0', a5.refillN, 0);
  eq('비활성 플래그 노출', a5.enabled, false);

  // 보충 제작은 업로드를 반드시 끄고 need 편을 요청해야 한다(버퍼가 즉시 발행되면 상한 붕괴).
  let seen = null;
  const rr = await inventory.refillInventory({
    cfg: CFG, need: 2,
    produce: async ({ cfg }) => { seen = cfg; return { ok: true, produced: [{ slug: 'x' }, { slug: 'y' }] }; },
  });
  eq('보충 제작 cfg 는 upload 차단', seen?.upload?.enabled, false);
  eq('보충 제작 best_n = need', seen?.pick?.best_n, 2);
  eq('보충 편수 집계', rr.produced, 2);
  const rr2 = await inventory.refillInventory({ cfg: CFG, need: 1, produce: async () => { throw new Error('claude 죽음'); } });
  eq('보충 실패는 비차단 보고', rr2.ok, false);
  eq('보충 실패 사유 보존', rr2.error, 'claude 죽음');
  eq('need<=0 은 no-op', (await inventory.refillInventory({ cfg: CFG, need: 0, produce: async () => ({ ok: true }) })).skipped, 'not_needed');
}

// ─── (g) 오늘 몫 완료 후에만 버퍼 보충 ───────────────────────────────────────
console.log('\n(g) 오늘 3편 완료 후 재고 버퍼 보충');
{
  let refillArg = null;
  const r = await slot.runSlot({
    cfg: CFG,
    deps: {
      now: kst('2026-08-05T18:05:00'),
      loadIndex: () => indexWithUploads(2, '2026-08-05T09:00:00Z'),
      uploadReadiness: readyStub,
      runDaily: async () => ({ ok: true, subject: '신규', youtube: 'https://youtube.com/shorts/new' }),
      uploadProducedFallback: fallbackStub(0),
      notifier: notifierStub(),
      refillInventory: async (arg) => { refillArg = arg; return { ok: true, produced: 1 }; },
    },
  });
  eq('오늘 3편 달성', r.today_total, 3);
  eq('보충 호출됨', refillArg?.need, 1);
  eq('보충 결과 보고', r.refill?.produced, 1);
  eq('정상 종료', r.exit, 0);

  // 제작이 실패한 슬롯에서는 버퍼 보충을 시도하지 않는다(claude 가 죽은 날 토큰 낭비 금지).
  let called = false;
  await slot.runSlot({
    cfg: CFG,
    deps: {
      now: kst('2026-08-06T18:05:00'),
      loadIndex: () => indexWithUploads(2, '2026-08-06T09:00:00Z'),
      uploadReadiness: readyStub,
      runDaily: async () => { throw new Error('claude 실행 실패'); },
      uploadProducedFallback: fallbackStub(1),
      notifier: notifierStub(),
      refillInventory: async () => { called = true; return { ok: true }; },
    },
  });
  eq('claude 장애 슬롯은 보충 안 함', called, false);
}

// ─── (h) staged(업로드 불가) 환경 회귀 — 경보·폴백 없음 ──────────────────────
console.log('\n(h) staged 환경 회귀(오탐 경보 금지)');
{
  const notifier = notifierStub();
  let fbCalled = 0;
  const r = await slot.runSlot({
    cfg: { ...CFG, upload: { enabled: false } },
    deps: {
      now: kst('2026-08-07T18:05:00'),
      loadIndex: () => ({}),
      uploadReadiness: () => ({ ready: false, reason: 'upload.enabled=false (채널 준비 전 — staged)' }),
      runDaily: async () => ({ ok: true, subject: 's', slug: 'sl', video: '/tmp/x.mp4', upload_skipped: 'upload.enabled=false' }),
      uploadProducedFallback: async () => { fbCalled++; return []; },
      notifier,
      refillInventory: async () => ({ ok: true }),
    },
  });
  eq('staged 는 기존 계약대로 정상', r.ok, true);
  eq('staged 종료코드 0', r.exit, 0);
  eq('staged 경보 없음', notifier.calls.length, 0);
  eq('staged 폴백 없음', fbCalled, 0);
}

// ─── 슬롯 계획 단위 검증 ─────────────────────────────────────────────────────
console.log('\n(i) 결손 보충 계획(slotPlan)');
{
  const p1 = slot.slotPlan({ now: kst('2026-08-08T10:05:00'), cap: 3, already: 0, want: 1 });
  eq('10시 첫 슬롯 기대 1편', p1.expected, 1);
  eq('10시 발행 1편', p1.n, 1);
  const p2 = slot.slotPlan({ now: kst('2026-08-08T12:05:00'), cap: 3, already: 0, want: 1 });
  eq('12시 결손 → 2편', p2.n, 2);
  const p3 = slot.slotPlan({ now: kst('2026-08-08T18:05:00'), cap: 3, already: 0, want: 1 });
  eq('18시(마지막) 결손 → 3편', p3.n, 3);
  ok('18시는 마지막 슬롯', p3.isLast);
  const p4 = slot.slotPlan({ now: kst('2026-08-08T18:05:00'), cap: 3, already: 3, want: 1 });
  eq('상한 도달 시 0편', p4.n, 0);
  const p5 = slot.slotPlan({ now: kst('2026-08-08T18:05:00'), cap: 3, already: 1, want: 1 });
  eq('1/3 상태 마지막 슬롯 → 2편', p5.n, 2);
  eq('KST 시각 파싱', slot.kstHour(kst('2026-08-08T00:30:00')), 0);
}

// ─── (j) 상한 키 해석 — upload.daily_cap 없어도 pick.daily_target 을 존중 ──────
console.log('\n(j) 일일 상한 config 키 해석');
{
  let runCalled = 0;
  const r = await slot.runSlot({
    cfg: { enabled: true, pick: { best_n: 1, daily_target: 3 }, backlog: {}, upload: { enabled: true } },
    deps: {
      now: kst('2026-08-09T18:05:00'),
      loadIndex: () => indexWithUploads(3, '2026-08-09T09:00:00Z'),
      uploadReadiness: readyStub,
      runDaily: async () => { runCalled++; return { ok: true, youtube: 'x' }; },
      uploadProducedFallback: fallbackStub(3),
      notifier: notifierStub(),
      refillInventory: async () => ({ ok: true }),
    },
  });
  eq('pick.daily_target=3 를 상한으로 인식', r.cap, 3);
  eq('상한 도달 → 무발행', r.skipped, 'daily_cap');
  eq('제작 미호출', runCalled, 0);
}

// ─── (k) claude 실패 분류 ────────────────────────────────────────────────────
console.log('\n(k) claude 실패 분류(classifyClaudeFailure)');
{
  // 이번 실사고 형태: stderr 공백 + stdout 에 오류 JSON (--output-format json 이라 이쪽이 유력)
  const real = lib.classifyClaudeFailure({
    message: 'Command failed: claude -p --output-format json --dangerously-skip-permissions',
    stderr: '',
    stdout: '{"type":"result","subtype":"error","is_error":true,"result":"Claude usage limit reached. Your limit will reset at 3pm."}',
    status: 1, versionOk: true,
  });
  eq('stderr 공백+stdout 한도 JSON → usage-limit', real.kind, 'usage-limit');
  eq('확신 high', real.confidence, 'high');
  ok('근거 문구 보존', /usage limit/i.test(real.evidence || ''), real.evidence);

  eq('ENOENT → cli-missing', lib.classifyClaudeFailure({ code: 'ENOENT', message: 'spawnSync claude ENOENT' }).kind, 'cli-missing');
  eq('ENOENT 확신 high', lib.classifyClaudeFailure({ code: 'ENOENT', message: 'x' }).confidence, 'high');
  eq('버전조회 실패 → cli-missing', lib.classifyClaudeFailure({ message: 'Command failed', versionOk: false }).kind, 'cli-missing');
  eq('버전조회 실패 확신 medium', lib.classifyClaudeFailure({ message: 'Command failed', versionOk: false }).confidence, 'medium');

  eq('인증 신호 → auth', lib.classifyClaudeFailure({ stdout: '{"is_error":true,"result":"Invalid API key · Please run /login"}', versionOk: true }).kind, 'auth');
  eq('401 → auth', lib.classifyClaudeFailure({ stderr: 'HTTP 401 unauthorized', versionOk: true }).kind, 'auth');
  eq('429 → usage-limit', lib.classifyClaudeFailure({ stderr: 'API error: HTTP 429', versionOk: true }).kind, 'usage-limit');

  eq('SIGTERM(우리가 죽임) → timeout', lib.classifyClaudeFailure({ killed: true, signal: 'SIGTERM', message: 'Command failed', versionOk: true }).kind, 'timeout');
  eq('timed out 문구 → timeout', lib.classifyClaudeFailure({ stderr: 'request timed out after 300s', versionOk: true }).kind, 'timeout');
  eq('ECONNRESET → network', lib.classifyClaudeFailure({ stderr: 'fetch failed: ECONNRESET', versionOk: true }).kind, 'network');
  eq('529 overloaded → network', lib.classifyClaudeFailure({ stdout: '{"error":"overloaded_error","status":529}', versionOk: true }).kind, 'network');

  // 애매하면 unknown — 억지 분류 금지, 원문은 보존
  const unk = lib.classifyClaudeFailure({
    message: 'Command failed: claude -p --output-format json --dangerously-skip-permissions',
    stderr: '', stdout: '', status: 1, versionOk: true,
  });
  eq('신호 없음 → unknown', unk.kind, 'unknown');
  eq('unknown 확신 low', unk.confidence, 'low');
  eq('unknown 근거는 null(억지 분류 금지)', unk.evidence, null);
  ok('unknown 조치는 로그 확인 안내', /원인 불명/.test(lib.failureAction('unknown')) && /last-claude-failure/.test(lib.failureAction('unknown')));
  ok('한도 조치는 대기 안내', /무의미/.test(lib.failureAction('usage-limit')));
}

// ─── (l) callClaude 진단 수집·재시도 정책 ────────────────────────────────────
console.log('\n(l) callClaude 진단 수집 · 재시도 정책');
{
  const noVersion = () => ({ ok: true, version: '1.2.3 (Claude Code)' });
  /** execFileSync 실패 모사 */
  const boom = ({ message = 'Command failed: claude -p --output-format json --dangerously-skip-permissions', stdout = '', stderr = '', status = 1, code, signal, killed } = {}) => {
    const e = new Error(message);
    Object.assign(e, { stdout, stderr, status, code, signal, killed });
    throw e;
  };

  // (l-1) 확실한 한도 신호 → 무의미한 재시도 없이 즉시 포기
  let calls = 0;
  let caught = null;
  try {
    lib.callClaude('p', {
      retryBaseMs: 0, versionProbe: noVersion, onFailure: () => {},
      exec: () => { calls++; boom({ stderr: '', stdout: JSON.stringify({ is_error: true, result: 'Claude usage limit reached. Resets at 3pm.' }) }); },
    });
  } catch (e) { caught = e; }
  eq('한도 신호 시 exec 1회만(재시도 생략)', calls, 1);
  eq('진단 첨부', caught?.diag?.kind, 'usage-limit');
  ok('재시도 생략 사유 기록', /재시도 생략/.test(caught?.diag?.aborted_early || ''), caught?.diag?.aborted_early);
  eq('stderr 공백 사실 기록', caught?.diag?.stderr_empty, true);
  eq('exit code 수집', caught?.diag?.exit_code, 1);
  eq('시도 횟수 기록', caught?.diag?.attempts, 1);
  ok('소요시간 기록', Number.isFinite(caught?.diag?.elapsed_ms));
  ok('CLI 버전 기록', /1\.2\.3/.test(caught?.diag?.cli_version || ''), caught?.diag?.cli_version);
  ok('stdout 원문 보존', /usage limit/i.test(caught?.diag?.stdout_excerpt || ''));

  // (l-2) 애매한 실패(=07-25 형태) → 기존 재시도 3회 유지 + unknown 분류 + 원문 보존
  calls = 0; caught = null;
  try {
    lib.callClaude('p', {
      retryBaseMs: 0, versionProbe: noVersion, onFailure: () => {},
      exec: () => { calls++; boom({ stderr: '', stdout: '' }); },
    });
  } catch (e) { caught = e; }
  eq('transient 은 4회 시도(재시도 정책 유지)', calls, 4);
  eq('애매 → unknown', caught?.diag?.kind, 'unknown');
  eq('시도 횟수 4', caught?.diag?.attempts, 4);
  ok('원문 message 보존', /Command failed: claude -p/.test(caught?.diag?.message || ''), caught?.diag?.message);
  ok('에러 메시지에 stderr 공백 명시', /stderr 비어있음/.test(caught?.message || ''), caught?.message);

  // (l-3) 응답 레벨 오류(stdout JSON) 도 분류 — 한도면 즉시 포기
  calls = 0; caught = null;
  try {
    lib.callClaude('p', {
      retryBaseMs: 0, versionProbe: noVersion, onFailure: () => {},
      exec: () => { calls++; return JSON.stringify({ subtype: 'error', is_error: true, result: 'usage limit reached — upgrade to continue' }); },
    });
  } catch (e) { caught = e; }
  eq('응답레벨 한도도 1회만', calls, 1);
  eq('응답레벨 한도 분류', caught?.diag?.kind, 'usage-limit');

  // (l-4) 응답 레벨 오류가 애매하면 재시도 유지
  calls = 0; caught = null;
  try {
    lib.callClaude('p', {
      retryBaseMs: 0, versionProbe: noVersion, onFailure: () => {},
      exec: () => { calls++; return JSON.stringify({ subtype: 'error', is_error: true, result: '알 수 없는 실패' }); },
    });
  } catch (e) { caught = e; }
  eq('애매한 응답오류는 4회 시도', calls, 4);
  eq('애매한 응답오류 분류 unknown', caught?.diag?.kind, 'unknown');

  // (l-5) 정상 경로 회귀 — 코드펜스 제거된 result 반환
  const okText = lib.callClaude('p', {
    versionProbe: noVersion,
    exec: () => JSON.stringify({ subtype: 'success', result: '```json\n{"a":1}\n```' }),
  });
  eq('정상 경로 불변', okText, '{"a":1}');

  // (l-6) 진단 파일 기록·로드 + 오래된 진단은 무시
  const diag = { at: new Date().toISOString(), kind: 'usage-limit', confidence: 'high', action: '대기', exit_code: 1 };
  lib.recordClaudeFailure(diag);
  eq('진단 파일 로드', lib.loadLastClaudeFailure()?.kind, 'usage-limit');
  lib.recordClaudeFailure({ at: new Date(Date.now() - 10 * 60 * 1000).toISOString(), kind: 'network' });
  eq('10분 전 진단은 유효', lib.loadLastClaudeFailure()?.kind, 'network');
  eq('maxAgeMs 5분이면 만료 처리', lib.loadLastClaudeFailure({ maxAgeMs: 5 * 60 * 1000 }), null);
  lib.recordClaudeFailure({ at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), kind: 'auth' });
  eq('3시간 전 진단은 기본 만료', lib.loadLastClaudeFailure(), null);
}

// ─── (m) 경보 본문에 진단 탑재 · 원시 JSON 금지 ──────────────────────────────
console.log('\n(m) 경보 본문 진단 탑재 · 원시 JSON 금지');
{
  const usageDiag = {
    at: new Date().toISOString(), kind: 'usage-limit', confidence: 'high',
    evidence: 'usage limit reached', action: lib.failureAction('usage-limit'),
    exit_code: 1, signal: null, attempts: 1, max_attempts: 4, elapsed_ms: 2345,
    cli_version: '1.2.3', stderr_empty: true, aborted_early: 'usage-limit(확실) — 재시도 생략',
    stdout_excerpt: '{"type":"result","is_error":true,"result":"Claude usage limit reached"}',
    message: 'Command failed: claude -p',
  };
  const p1 = slot.buildNoGapPayload({ now: kst('2026-08-10T18:05:00'), already: 0, cap: 3, planned: 3, diag: usageDiag, produceError: 'claude 실행 실패(usage-limit): Command failed' });
  ok('사유에 갈래 표기', /원인 usage-limit/.test(p1.reason), p1.reason);
  ok('진단 라벨 포함', /구독 사용량 한도 소진/.test(p1.details));
  ok('조치 문구 포함', /무의미/.test(p1.details));
  ok('신호(exit·시도·CLI버전) 포함', /exit=1/.test(p1.details) && /시도 1\/4회/.test(p1.details) && /CLI 1\.2\.3/.test(p1.details), p1.details);
  ok('stderr 공백 사실 포함', /stderr 비어있음/.test(p1.details));
  ok('재시도 생략 표기', /재시도 생략됨/.test(p1.details));
  ok('원시 JSON 없음(중괄호·따옴표)', !/[{}"]/.test(p1.details), p1.details);
  ok('Markdown 활성문자 없음(백틱·별표)', !/[`*_]/.test(p1.details));
  ok('reason 에도 원시 JSON 없음', !/[{}"]/.test(p1.reason));

  const unknownDiag = { at: new Date().toISOString(), kind: 'unknown', confidence: 'low', evidence: null, action: lib.failureAction('unknown'), exit_code: 1, attempts: 4, max_attempts: 4, elapsed_ms: 51234, cli_version: null, stderr_empty: true, message: 'Command failed: claude -p' };
  const p2 = slot.buildNoGapPayload({ now: kst('2026-08-10T18:05:00'), already: 1, cap: 3, planned: 2, diag: unknownDiag });
  ok('unknown 라벨', /원인 불명/.test(p2.details));
  ok('unknown 이면 사람 확인 순서 제공', /확인할 것/.test(p2.details));
  ok('진단 파일 경로 안내', /last-claude-failure\.json/.test(p2.details));
  ok('CLI 버전조회 실패 표기', /CLI 버전조회 실패/.test(p2.details));
  ok('unknown 도 원시 JSON 없음', !/[{}"]/.test(p2.details));

  // 진단이 err.diag 로 안 올라와도 파일 폴백으로 원인이 실린다
  const notifier = notifierStub();
  const r = await slot.runSlot({
    cfg: CFG,
    deps: {
      now: kst('2026-08-11T18:05:00'),
      loadIndex: () => ({}),
      uploadReadiness: readyStub,
      // 예외 없이 ok:false 만 반환(run-curiosity 가 후보별 예외를 삼킨 형태)
      runDaily: async () => ({ ok: false, pick: null, reason: '병행 제작 후보 전원 탈락' }),
      uploadProducedFallback: fallbackStub(0),
      notifier,
      loadLastClaudeFailure: () => ({ at: new Date().toISOString(), kind: 'auth', confidence: 'high', action: lib.failureAction('auth'), exit_code: 1, attempts: 4, max_attempts: 4, elapsed_ms: 900, stderr_empty: true }),
      refillInventory: async () => ({ ok: true }),
    },
  });
  eq('파일 폴백 진단 채택', r.diagnosis?.kind, 'auth');
  ok('경보에 인증 갈래 표기', /원인 auth/.test(notifier.calls[0]?.payload?.reason || ''), notifier.calls[0]?.payload?.reason);
  ok('인증 조치 문구', /로그인/.test(notifier.calls[0]?.payload?.details || ''));
  eq('제작 예외가 아니면 exit 1', r.exit, 1);

  // sanitize 단위 — 원시 JSON·Markdown 문자를 확실히 제거
  eq('sanitize 중괄호 제거', /[{}]/.test(slot.sanitizeForAlert('{"a":1}')), false);
  eq('sanitize 백틱·별표 제거', /[`*]/.test(slot.sanitizeForAlert('`code` *bold*')), false);
  eq('sanitize 길이 절단', slot.sanitizeForAlert('x'.repeat(500), 100).length <= 101, true);
  eq('진단 없으면 빈 배열', slot.describeDiag(null).length, 0);
}

// ─── 정리 ────────────────────────────────────────────────────────────────────
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 임시 디렉터리 정리 실패 무시 */ }

console.log(`\n무결방 가드(US-008): ${passN} pass / ${failN} fail`);
process.exit(failN === 0 ? 0 : 1);
