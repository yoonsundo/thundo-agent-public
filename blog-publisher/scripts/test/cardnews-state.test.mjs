#!/usr/bin/env node
/**
 * cardnews-state.test.mjs — 카드뉴스 상태 I/O 유닛테스트 (계획 §5.1/§5.2 · Step 4a "1부")
 *
 * 1부가 증명하는 것(Step 4a 완료 정의):
 *   ① 불허 전이 3종 이상이 **throw** 한다 — 전이표(§5.2)가 장식이 아님
 *   ② `flush` 가 **같은 상태에서 throw 하지 않는다** — write-ahead 를 전이표가 거부하면
 *      모든 resume 진입이 죽는다(ADR-2 가 이 분리를 결정한 이유). 그래서 이 테스트는
 *      "transition(x, 같은상태) 는 막히고 flush 는 통과한다"를 한 쌍으로 확인한다
 *   ③ **실제 자식 프로세스를 SIGKILL** 해서 tmp 쓰기와 rename 사이에서 죽인 뒤,
 *      기존 index.json 이 그대로 파싱되고 잔여물이 tmp 하나뿐임을 확인(§7.3 시나리오 13).
 *      가짜 fs 로 흉내내지 않는다 — ADR-2 의 crash-safety 주장은 실증이 필요하다
 *   ④ `held_class`/`held_diag` 가 **모든 held 경로**에 기록된다(§5.1 held_reason 어휘 전건 +
 *      전이표에서 held 로 들어오는 간선 전건). 스펙 1-B 의 "원인 분류 가능" 요건
 *   ⑤ `appendRun` 이 **post 가 하나도 없을 때도** 기록된다(§3.21 · 시나리오 26) —
 *      claude 장애는 post_id 가 발급되기 전에 일어나므로 post 단위 기록으로는 아무것도 안 남는다
 *   ⑥ `postIdFor` 결정론 + KST 날짜 자리 — `host.mjs:objectPath` 가 되파싱하는 형식 계약
 *   ⑦ `classifyFailure` 포크 판정(원본 shorts-curiosity 는 무수정)
 *
 * 2부(Step 4b 폴트 인젝션 §7.3)는 이 파일 하단 마커 위에 `part(2, …)` 로 추가한다.
 * `--part=1` / `--part=2`(또는 `CARDNEWS_TEST_PART`)로 부분 실행, 인자 없으면 전부 실행.
 *
 * 네트워크·크리덴셜 불필요. 실 state/ 오염 금지 — paths 는 config.mjs import 시점에
 * 확정되므로 STATE_DIR_OVERRIDE 를 먼저 세팅하고 동적 import 한다.
 * exit 0 = 전체 통과 / 1 = 실패.
 */
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, unlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const TMP = mkdtempSync(join(tmpdir(), 'cardnews-state-'));
process.env.STATE_DIR_OVERRIDE = TMP;   // 실 state/ 격리 — 반드시 import 전
process.env.RUN_MODE = 'mock';

const LIB_URL = new URL('../cardnews/lib.mjs', import.meta.url).href;
const lib = await import(LIB_URL);
const host = await import('../cardnews/host.mjs');

// ─── 하네스 ───────────────────────────────────────────────────────────────────

let passN = 0, failN = 0;
function ok(label, cond, extra = '') {
  if (cond) { console.log(`  [PASS] ${label}`); passN++; }
  else { console.log(`  [FAIL] ${label}${extra ? ` — ${extra}` : ''}`); failN++; }
}
const eq = (label, got, want) => ok(label, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

/** fn 이 throw 하는가. 메시지 일부(needle)까지 확인해 "엉뚱한 이유로 throw" 를 걸러낸다. */
function throws(label, fn, needle = '') {
  try { fn(); ok(label, false, 'throw 하지 않았다'); }
  catch (e) {
    ok(label, !needle || e.message.includes(needle), `메시지='${e.message}' needle='${needle}'`);
  }
}
function noThrow(label, fn) {
  try { fn(); ok(label, true); return true; }
  catch (e) { ok(label, false, `throw: ${e.message}`); return false; }
}

const PARTS = [];
const part = (n, name, fn) => PARTS.push({ n, name, fn });
const section = (s) => console.log(`\n${s}`);

/** 인덱스 초기화(테스트 블록 간 간섭 제거). */
function resetIndex() {
  if (existsSync(lib.indexPath())) unlinkSync(lib.indexPath());
}

/** postId 를 목표 상태까지 전이표대로 몰고 간다(불법 지름길 없음). */
const CHAIN = ['planned', 'scripted', 'rendered', 'hosted', 'child_containers_partial',
  'carousel_container_created', 'publish_unknown', 'published'];
function drive(postId, upto, patch = {}) {
  let post = null;
  for (const s of CHAIN) {
    post = lib.transition(postId, s, s === upto ? patch : {});
    if (s === upto) return post;
  }
  throw new Error(`drive: 알 수 없는 목표 상태 ${upto}`);
}

// ═══ 1부 ══════════════════════════════════════════════════════════════════════

part(1, '상태 I/O + 전이표', async () => {

  // ─── ⑤ appendRun — post 가 아예 없을 때 (§3.21 · 시나리오 26) ──────────────
  section('[1] appendRun — run-scoped: post 가 하나도 없어도 기록된다');
  resetIndex();
  if (existsSync(lib.runsPath())) unlinkSync(lib.runsPath());

  const diag = lib.classifyFailure({ stderr: 'Error: usage limit reached', status: 1 });
  const row = lib.appendRun({
    slot: '11', outcome: 'error', failure_stage: 'pick', failure_class: 'transient', diag,
    started_at: '2026-08-01T02:00:00.000Z', now: new Date('2026-08-01T02:00:09.000Z'),
  });
  ok('runs.jsonl 이 생성됐다', existsSync(lib.runsPath()));
  ok('index.json 은 여전히 없다(post 미생성 = 인덱스 무흔적)', !existsSync(lib.indexPath()));
  eq('date 는 KST', row.date, '2026-08-01');
  eq('post_id 는 null 이어도 기록된다', row.post_id, null);
  eq('failure_stage 보존', row.failure_stage, 'pick');
  eq('diag.kind 보존', row.diag.kind, 'usage-limit');

  lib.appendRun({ outcome: 'published', post_id: 'cn-2026-08-01-abcdefabcd' });
  const bogus = lib.appendRun({ outcome: 'weird-outcome' });
  eq('미지의 outcome 은 error 로 클램프(기록 자체를 잃지 않는다)', bogus.outcome, 'error');
  const runs = lib.loadRuns();
  eq('append-only — 3줄', runs.length, 3);
  eq('첫 줄 불변(덮어쓰기 아님)', runs[0].failure_stage, 'pick');
  ok('마지막 줄이 마지막 append', runs[2].outcome === 'error' && runs[1].outcome === 'published');

  // ─── ⑥ postIdFor — 날짜 자리는 형식 계약 ─────────────────────────────────
  section('[2] postIdFor — 결정론 · KST · host.objectPath 역파싱 계약');
  const t = new Date('2026-08-01T02:00:00.000Z');   // KST 11:00
  const pid = lib.postIdFor('a1b2c3d4ef', t);
  eq('형식', pid, 'cn-2026-08-01-a1b2c3d4ef');
  eq('결정론 — 같은 날 같은 아이템 = 같은 id(이어받기)', lib.postIdFor('a1b2c3d4ef', new Date('2026-08-01T09:30:00.000Z')), pid);
  eq('KST 23:59(=14:59Z) 는 아직 전날', lib.postIdFor('x1', new Date('2026-07-31T14:59:59.000Z')), 'cn-2026-07-31-x1');
  eq('KST 00:00(=15:00Z) 부터 다음 날', lib.postIdFor('x1', new Date('2026-07-31T15:00:00.000Z')), 'cn-2026-08-01-x1');
  ok('다른 백로그 아이템 = 다른 post_id', lib.postIdFor('bbbb', t) !== pid);
  throws('빈 backlogId 는 throw', () => lib.postIdFor('  ', t), 'backlogId');
  eq('idemMarker 는 하이픈 없는 #cn…', lib.idemMarker(pid), '#cn20260801a1b2c3d4ef');
  // 🔴 host.objectPath 가 post_id 에서 날짜를 되뽑는다 — 형식이 깨지면 경로가 "지금"으로 흐른다.
  //    접두어(host.path_prefix)는 별개 관심사라 여기선 날짜 자리만 본다.
  const objPath = host.objectPath(pid, 0, 'deadbeefcafebabe0123', new Date('2027-01-01T00:00:00.000Z'));
  ok('objectPath 가 post_id 날짜를 되파싱한다("지금"이 2027 이어도)',
    objPath.endsWith(`2026/08/01/${pid}/01-deadbeefcafebabe.jpg`) && !objPath.includes('2027'), objPath);

  // ─── ① 불허 전이 ────────────────────────────────────────────────────────
  section('[3] 전이표 강제 — 불허 간선은 throw');
  resetIndex();
  const P = 'cn-2026-08-01-aaaaaaaaaa';

  drive(P, 'published');
  eq('published 도달', lib.getPost(P).status, 'published');
  throws('❶ published → held (종단 상태)', () => lib.transition(P, 'held', { held_reason: 'takedown:테스트' }), '종단');
  throws('   published → publish_unknown 도 막힌다', () => lib.transition(P, 'publish_unknown'), '종단');

  resetIndex();
  lib.transition(P, 'planned');
  throws('❷ planned → rendered (단계 건너뛰기)', () => lib.transition(P, 'rendered'), '불허');
  throws('   planned → published (전 단계 우회)', () => lib.transition(P, 'published'), '불허');

  resetIndex();
  drive(P, 'hosted');
  throws('❸ hosted → hosted (self — write-ahead 를 transition 으로 쓰려는 시도)',
    () => lib.transition(P, 'hosted', { public_url: ['u'] }), 'flush');

  resetIndex();
  drive(P, 'hosted');
  lib.transition(P, 'held', { held_reason: 'host:verify-failed' });
  throws('❹ held → published (유일한 탈출구는 hosted)', () => lib.transition(P, 'published'), '불허');
  noThrow('   held → hosted 는 허용(§3.14.3 step 2)',
    () => lib.transition(P, 'hosted', { held_reason: null, held_class: null, held_diag: null, revived_at: new Date().toISOString() }));

  throws('미지의 상태 이름은 throw', () => lib.transition(P, 'nonsense'), '미지의 to');
  throws('null → planned 외 진입 금지', () => { resetIndex(); lib.transition('cn-2026-08-01-bbbbbbbbbb', 'hosted'); }, '불허');

  // 전이표 자체가 §5.2 표와 일치하는지(간선 목록 전건 대조)
  const WANT_TABLE = {
    null: ['planned'],
    planned: ['scripted', 'held'],
    scripted: ['rendered', 'held'],
    rendered: ['hosted', 'held'],
    hosted: ['child_containers_partial', 'held'],
    child_containers_partial: ['child_containers_partial', 'carousel_container_created', 'held'],
    carousel_container_created: ['carousel_container_created', 'publish_unknown', 'child_containers_partial', 'held'],
    publish_unknown: ['publish_unknown', 'published', 'held'],
    held: ['hosted'],
    published: [],
  };
  const norm = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, [...v].sort().join('|')]));
  eq('전이표가 §5.2 와 정확히 일치', JSON.stringify(norm(lib.TRANSITIONS)), JSON.stringify(norm(WANT_TABLE)));

  // ─── ② flush — 같은 상태에서 throw 하지 않는다 ───────────────────────────
  section('[4] flush — 같은 상태 영속화(write-ahead)는 전이표를 타지 않는다');
  resetIndex();
  drive(P, 'child_containers_partial');
  const before = lib.getPost(P);

  noThrow('flush 1회차 (자식 컨테이너 write-ahead)',
    () => lib.flush(P, { child_container_ids: ['17901'], child_created_at: ['2026-08-01T02:01:40.112Z'] }));
  noThrow('flush 2회차 — 같은 상태 반복 flush 도 통과',
    () => lib.flush(P, { child_container_ids: ['17901', '17902'] }));
  noThrow('flush 3회차 (캐러셀 매칭키 write-ahead)',
    () => lib.flush(P, { caption_sha256: '9f2c', idem_marker: lib.idemMarker(P) }));

  const after = lib.getPost(P);
  eq('상태는 그대로', after.status, 'child_containers_partial');
  eq('필드는 디스크에 남았다', after.child_container_ids.length, 2);
  eq('caption_sha256 영속화', after.caption_sha256, '9f2c');

  const hist = after.history;
  const flushes = hist.filter(h => h.kind === 'flush');
  const moves = hist.filter(h => !h.kind);
  eq('history 가 flush 3건을 kind:"flush" 로 구분', flushes.length, 3);
  eq('상태 전이 이력은 그대로 5건(planned…child_containers_partial)', moves.length, before.history.length);
  ok('flush 이력은 keys 를 남긴다', Array.isArray(flushes[0].keys) && flushes[0].keys.includes('child_container_ids'),
    JSON.stringify(flushes[0]));
  ok('flush 이력에 from/to 가 없다(상태를 안 바꿨으므로)', flushes[0].from === undefined && flushes[0].to === undefined);
  ok('전이 이력에는 from/to 가 있다', moves[0].from === null && moves[0].to === 'planned');
  ok('양쪽 다 attempt_id 를 남긴다', flushes[0].attempt_id === 'att-1' && moves[0].attempt_id === 'att-1');

  throws('flush 로 status 를 바꾸려 하면 throw', () => lib.flush(P, { status: 'published' }), 'transition');
  throws('없는 post 에 flush 하면 throw', () => lib.flush('cn-2026-08-01-zzzzzzzzzz', { caption: 'x' }), '인덱스에 없는');

  // 🔴 이 한 쌍이 ADR-2 의 요지다: 같은 상태 영속화를 transition 으로 쓰면 죽고, flush 면 산다.
  //    §3.14.3 step 3 의 `else flush({slide_sha256, public_url})` 이 정확히 이 자리다 —
  //    resume 이 `hosted` 로 재진입해 산출물을 다시 남기는 경로(전이표에 hosted→hosted 없음).
  resetIndex();
  drive(P, 'hosted');
  throws('같은 상태(hosted) 재영속화: transition 은 막히고',
    () => lib.transition(P, 'hosted', { slide_sha256: ['3a91'], public_url: ['https://x/1.jpg'] }), 'flush');
  noThrow('                              flush 는 통과한다',
    () => lib.flush(P, { slide_sha256: ['3a91'], public_url: ['https://x/1.jpg'] }));
  eq('resume 재영속화 후에도 상태는 hosted', lib.getPost(P).status, 'hosted');
  eq('필드는 남았다', lib.getPost(P).public_url[0], 'https://x/1.jpg');

  // ─── ④ held_class/held_diag — 모든 held 경로 ────────────────────────────
  section('[5] held — 분류 없는 held 는 만들 수 없다');

  // (a) §5.1 held_reason 어휘 전건
  const VOCAB = [
    ['readiness:publish.enabled=false (무인 발행 차단)', 'external'],
    ['limit:quota 50/50', 'external'],
    ['gate:generalization', 'permanent'],
    ['gate:image', 'permanent'],
    ['factcheck:doubtful', 'permanent'],
    ['factcheck:correction-unapplicable', 'permanent'],
    ['meta:media-fetch', 'transient'],
    ['meta:token-expired', 'external'],
    ['host:verify-failed', 'transient'],
    ['child:incomplete', 'transient'],
    ['container:expired', 'transient'],
    ['reconcile:ambiguous', 'permanent'],
    ['reconcile:stale', 'permanent'],
    ['publish:retry-exhausted', 'permanent'],
    ['publish:issue-cap', 'permanent'],
    ['held:permanent', 'permanent'],
    ['held:artifacts-gone', 'permanent'],
    ['takedown:저작권 신고', 'external'],
  ];
  let vocabBad = [];
  for (const [reason, want] of VOCAB) {
    const got = lib.classifyHeld(reason, null);
    if (got !== want) vocabBad.push(`${reason}: got=${got} want=${want}`);
  }
  ok(`§5.1 held_reason 어휘 ${VOCAB.length}종 전건 분류`, vocabBad.length === 0, vocabBad.join(' / '));
  ok('external 은 화이트리스트뿐 — 나머지는 1-A 집계에 남는다',
    VOCAB.filter(([, c]) => c === 'external').length === 4);

  // (b) 전이표에서 held 로 들어오는 간선 전건 — 어느 경로로 들어와도 분류가 남는가
  const heldFroms = Object.entries(lib.TRANSITIONS).filter(([, to]) => to.includes('held')).map(([f]) => f);
  eq('held 진입 간선 7개(§5.2)', heldFroms.length, 7);
  let heldBad = [];
  for (const from of heldFroms) {
    resetIndex();
    const id = `cn-2026-08-01-h${from.slice(0, 8)}`;
    drive(id, from);
    const d = lib.classifyFailure({ stderr: 'ECONNRESET while fetching', status: 1 });
    const p = lib.transition(id, 'held', { held_reason: 'meta:media-fetch', held_diag: d });
    if (p.status !== 'held') heldBad.push(`${from}: status=${p.status}`);
    if (!lib.HELD_CLASSES.includes(p.held_class)) heldBad.push(`${from}: held_class=${p.held_class}`);
    if (!('held_diag' in p) || !p.held_diag) heldBad.push(`${from}: held_diag 없음`);
    // 디스크 왕복까지 확인 — 메모리 객체만 맞고 저장이 빠지면 다음 런이 못 읽는다
    const disk = lib.getPost(id);
    if (disk.held_class !== p.held_class || disk.held_diag?.kind !== 'network') heldBad.push(`${from}: 디스크 불일치`);
  }
  ok(`held 진입 간선 ${heldFroms.length}건 전부 held_class/held_diag 기록`, heldBad.length === 0, heldBad.join(' / '));

  // (c) 구조적 불가능성 — held_reason 없이는 held 가 될 수 없다
  resetIndex();
  drive(P, 'hosted');
  throws('held_reason 없는 held 는 throw', () => lib.transition(P, 'held', {}), 'held_reason');
  eq('throw 후 상태 미변경', lib.getPost(P).status, 'hosted');

  // (d) held_diag 로 갈래를 좁히는 경로(사유만으로는 모르는 claude 장애)
  eq('claude 한도 → external', lib.classifyHeld('script:claude-failed', { kind: 'usage-limit' }), 'external');
  eq('claude 인증 → external', lib.classifyHeld('script:claude-failed', { kind: 'auth' }), 'external');
  eq('claude 네트워크 → transient', lib.classifyHeld('script:claude-failed', { kind: 'network' }), 'transient');
  eq('진단 없는 미지 사유 → transient(모르는 것을 external 로 두면 1-A 가 스스로를 면제한다)',
    lib.classifyHeld('무슨:일이지', null), 'transient');
  ok('classifyHeld 반환은 항상 3갈래 중 하나',
    ['', 'x', 'meta:', null, undefined].every(r => lib.HELD_CLASSES.includes(lib.classifyHeld(r))));

  // (e) held_diag 미지정이어도 키는 존재한다(부분 기록이 undefined 로 사라지지 않게)
  resetIndex();
  drive(P, 'scripted');
  const gateHeld = lib.transition(P, 'held', { held_reason: 'gate:generalization' });
  eq('게이트 fail 은 permanent', gateHeld.held_class, 'permanent');
  ok('held_diag 키는 존재(값 null)', 'held_diag' in gateHeld && gateHeld.held_diag === null);

  // ─── ⑦ classifyFailure 포크 ─────────────────────────────────────────────
  section('[6] classifyFailure — 07-25 의 "Command failed" 한 줄을 갈래로 바꾼다');
  eq('ENOENT → cli-missing', lib.classifyFailure({ code: 'ENOENT' }).kind, 'cli-missing');
  eq('usage limit → usage-limit', lib.classifyFailure({ stderr: 'Claude usage limit reached' }).kind, 'usage-limit');
  eq('401 → auth', lib.classifyFailure({ stderr: 'HTTP 401 unauthorized' }).kind, 'auth');
  eq('killed → timeout', lib.classifyFailure({ killed: true, signal: 'SIGTERM' }).kind, 'timeout');
  eq('ECONNRESET → network', lib.classifyFailure({ stderr: 'ECONNRESET' }).kind, 'network');
  eq('versionOk=false → cli-missing', lib.classifyFailure({ stderr: 'huh', versionOk: false }).kind, 'cli-missing');
  const unk = lib.classifyFailure({ stderr: '', message: 'Command failed: claude -p', status: 1 });
  eq('모르면 unknown', unk.kind, 'unknown');
  eq('confidence 도 낮게', unk.confidence, 'low');
  ok('진단 메타(exit_code/signal/stderr_empty)를 함께 남긴다',
    unk.exit_code === 1 && unk.signal === null && unk.stderr_empty === true, JSON.stringify(unk));

  // ─── ③ SIGKILL mid-write ────────────────────────────────────────────────
  section('[7] SIGKILL mid-write — 실제 프로세스를 죽인다(§7.3 시나리오 13 · ADR-2)');
  await sigkillMidWrite();
});

/**
 * 자식 프로세스가 `saveIndexAtomic` 의 tmp 를 연 직후(= rename 전) SIGKILL 한다.
 * 가짜 fs 로 흉내내지 않는 이유: 우리가 증명하려는 것은 "rename 이 원자적이라 크래시가
 * index.json 을 반쪽으로 만들지 않는다"이고, 그건 실제 커널 동작이다.
 *
 * 타이밍 창을 확실히 잡기 위해 ①자식은 수 MB 인덱스를 쓰고 ②부모는 `index.json.<자식pid>.tmp`
 * 를 논블로킹으로 폴링해 보이는 즉시 죽인다. tmp 이름에 자식 pid 가 박혀 있어 "그 자식이
 * 만든 tmp" 임이 확정된다. 창을 놓치면(자식이 rename 까지 완주) 페이로드를 키워 재시도한다.
 */
async function sigkillMidWrite() {
  resetIndex();
  const P = 'cn-2026-08-01-sentinel00';
  drive(P, 'hosted', { public_url: ['https://example/1.jpg'], slide_sha256: ['3a91'] });
  const priorRaw = readFileSync(lib.indexPath(), 'utf8');
  const dir = dirname(lib.indexPath());

  const CHILD_SRC = [
    "const lib = await import(process.env.CN_LIB);",
    "const { writeFileSync } = await import('node:fs');",
    "const n = Number(process.env.CN_N);",
    "const idx = {};",
    "for (let i = 0; i < n; i++) {",
    "  const id = 'cn-2026-08-01-child' + i;",
    "  idx[id] = { post_id: id, status: 'planned', blob: 'x'.repeat(512) };",
    "}",
    "lib.saveIndexAtomic(idx);",           // ← 부모가 이 안에서 죽인다
    "writeFileSync(process.env.CN_DONE, 'done');",
  ].join('\n');

  const donePath = join(TMP, 'child-done');
  let caught = false, lastNote = '';

  for (let attempt = 1; attempt <= 6 && !caught; attempt++) {
    for (const f of readdirSync(dir)) if (f.endsWith('.tmp')) unlinkSync(join(dir, f));
    if (existsSync(donePath)) unlinkSync(donePath);

    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD_SRC], {
      env: { ...process.env, CN_LIB: LIB_URL, CN_N: String(20000 * attempt), CN_DONE: donePath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', c => { stderr += c; });
    child.stdout.resume();

    // 논블로킹 폴링 — 이벤트 루프를 막지 않아야 자식 종료도 감지된다
    const tmpPath = `${lib.indexPath()}.${child.pid}.tmp`;
    const deadline = Date.now() + 15000;
    let tmpSize = -1;
    while (Date.now() < deadline) {
      if (existsSync(tmpPath)) {
        try { tmpSize = statSync(tmpPath).size; } catch { tmpSize = -1; }
        try { process.kill(child.pid, 'SIGKILL'); caught = true; } catch { /* 이미 종료 */ }
        break;
      }
      if (existsSync(donePath) || child.exitCode !== null || child.signalCode !== null) break;  // 창을 놓쳤다
      await new Promise(r => setTimeout(r, 0));
    }

    const [code, signal] = await once(child, 'exit');
    if (!caught) { lastNote = `창 놓침(attempt ${attempt}, exit=${code}, stderr=${stderr.slice(0, 200)})`; continue; }

    eq('자식이 SIGKILL 로 죽었다(정상 종료가 아니다)', signal, 'SIGKILL');
    ok(`tmp 를 연 직후 죽였다 (tmp size=${tmpSize}B)`, tmpSize >= 0);

    // ① index.json 이 여전히 파싱된다 + 이전 상태 그대로
    let parsed = null;
    noThrow('크래시 후에도 index.json 이 파싱된다', () => { parsed = lib.loadIndex(); });
    eq('이전 상태가 온전하다(status)', parsed?.[P]?.status, 'hosted');
    eq('이전 상태가 온전하다(write-ahead 필드)', parsed?.[P]?.public_url?.[0], 'https://example/1.jpg');
    eq('바이트 단위로 손대지 않았다', readFileSync(lib.indexPath(), 'utf8'), priorRaw);
    ok('자식이 쓰던 내용은 반영되지 않았다(rename 미도달)', !('cn-2026-08-01-child0' in (parsed || {})));

    // ② 잔여물은 tmp 하나뿐
    const leftovers = readdirSync(dir).filter(f => f.startsWith('index.json.') && f.endsWith('.tmp'));
    eq('잔여물은 tmp 1개', leftovers.length, 1);
    eq('그 tmp 는 죽은 자식의 것(pid 각인)', leftovers[0], `index.json.${child.pid}.tmp`);
    ok('index.json 은 그대로 존재', existsSync(lib.indexPath()));

    // ③ 다음 런이 정상 동작한다(tmp 잔여가 인덱스를 오염시키지 않는다)
    noThrow('크래시 뒤 다음 전이가 정상 진행', () => lib.transition(P, 'child_containers_partial', { child_container_ids: ['1'] }));
    eq('전이 결과가 저장됐다', lib.getPost(P).status, 'child_containers_partial');

    for (const f of readdirSync(dir)) if (f.endsWith('.tmp')) unlinkSync(join(dir, f));
  }
  ok('SIGKILL 창을 실제로 잡았다', caught, lastNote || '6회 시도 모두 rename 완주 — 페이로드/폴링 재조정 필요');
}

// ═══ 2부 — 폴트 인젝션 §7.3 (Step 4b) ════════════════════════════════════════
//
// 이 파트가 증명하는 것은 하나다: **같은 게시물이 두 번 올라가지 않는다.** 그래서 거의 모든
// 단언이 "성공했다"가 아니라 "그 이상 쏘지 않았다"의 모양을 한다(`mediaPublish 추가 0회`).
//
// 🔴 시나리오 18이 이 파트의 척추다. 각 시나리오는 `publishPost` 를 **해당 상태로 직접
// 진입**시킨다 — 해피패스를 돌려놓고 상태만 흉내내면, 예전 개정판처럼 "모든 resume 진입이
// 첫 transition 에서 throw" 하는 버그를 테스트가 통과시켜 버린다.

part(2, '폴트 인젝션(§7.3) — 발행 상태 머신', async () => {
  const pub = await import('../cardnews/publish.mjs');
  const metaMod = await import('../cardnews/meta.mjs');

  process.env.SUPABASE_URL = 'https://stub.supabase.co';   // host.publicUrl 용(네트워크 없음)

  const TOKEN = { ig_user_id: '178414', access_token: 'stub', issued_at: 'x', expires_at: 'y' };
  const CFG = () => ({
    channel: {}, cards: { count: 7 },
    host: { bucket: 'cardnews', path_prefix: '', verify_timeout_ms: 1000 },
    publish: { enabled: true },
    meta: {
      container_ttl_ms: 72000000,          // 20h — 24h 아님
      reconcile_delay_ms: 45000,
      reconcile_lookback_ms: 1800000,      // 30분 — 양쪽 스큐
      recent_media_limit: 25,
      stale_publish_unknown_days: 7,
      max_confirmed_failed_republish: 1,
      max_publish_issued: 3,
      child_retry: { max: 3, base_ms: 1 },
      liveness_check: false,
    },
  });

  // ── 시계 · 산출물 · 스텁 ────────────────────────────────────────────────────
  let CLOCK = new Date('2026-08-01T02:00:00.000Z');
  const now = () => CLOCK;
  const nowIso = () => CLOCK.toISOString();
  const shift = (msDelta) => { CLOCK = new Date(CLOCK.getTime() + msDelta); };

  /** 7장의 sha·URL — URL 에 sha 앞 16자가 박히므로 verifyStored 교차검증이 성립한다. */
  function artifacts(postId) {
    const sha = [], urls = [];
    for (let i = 0; i < 7; i++) {
      const s = lib.sha256(`${postId}#slide${i}`);
      sha.push(s);
      urls.push(host.publicUrl('cardnews', host.objectPath(postId, i, s)));
    }
    return { sha, urls };
  }

  const RES = (status) => ({
    status,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'image/jpeg'
      : String(k).toLowerCase() === 'content-length' ? '500' : null) },
    text: async () => '', json: async () => ({}),
  });
  /** verifyStored 용 — `gone` 에 든 URL 만 404(산출물 소실 시뮬레이션). */
  const makeFetch = (gone = new Set()) => async (url) => RES(gone.has(url) ? 404 : 200);

  /**
   * meta 스텁 — **실제 모듈과 같은 시그니처**(token, args, {fetchImpl,cfg})에 더해
   * 가드 1회용 소비까지 흉내낸다. 그래야 "mediaPublish 0회" 단언이 호출자 규율을 증명한다
   * (게이트 자체의 증명은 실제 모듈을 쓰는 `test:cardnews-chokepoint` 시나리오 28 몫).
   */
  function makeMeta(opt = {}) {
    const calls = {
      guardPublish: 0, createChildContainer: 0, createCarouselContainer: 0,
      mediaPublish: 0, publishedOk: 0, noGuard: 0, findPublished: 0, getMedia: 0,
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
      async createChildContainer(token, { imageUrl }) {
        calls.createChildContainer++;
        const v = opt.child?.(calls.createChildContainer, imageUrl);
        if (v) return { createdAt: nowIso(), ...v };
        return { ok: true, containerId: `child-${++cN}`, createdAt: nowIso() };
      },
      async createCarouselContainer(token, { childIds }) {
        calls.createCarouselContainer++;
        const v = opt.carousel?.(calls.createCarouselContainer);
        if (v) return { createdAt: nowIso(), ...v };
        return {
          ok: true, containerId: `carousel-${calls.createCarouselContainer}`,
          createdAt: nowIso(), childrenKey: (childIds || []).join(','),
        };
      },
      async mediaPublish(token, { creationId, guardToken }) {
        calls.mediaPublish++;
        if (!guardToken || !guards.has(guardToken.id)) { calls.noGuard++; return { ok: false, outcome: 'rejected', reason: 'no-guard' }; }
        guards.delete(guardToken.id);            // 1회용
        const v = opt.publish?.(calls.mediaPublish, creationId);
        if (v) { if (v.ok) calls.publishedOk++; return v; }
        calls.publishedOk++;
        return { ok: true, mediaId: `media-${calls.mediaPublish}` };
      },
      async findPublished(token, args) {
        calls.findPublished++; calls.lastFind = args;
        return opt.find ? opt.find(calls.findPublished, args) : { ok: true, mediaId: null, ambiguous: false };
      },
      async getMedia(token, { mediaId }) {
        calls.getMedia++;
        return opt.media ? opt.media(calls.getMedia) : { ok: true, mediaId, permalink: 'https://www.instagram.com/p/x/' };
      },
      classifyMetaError: metaMod.classifyMetaError,
    };
  }

  let alerts = [], slept = [], renderCalls = 0;
  function deps(meta, { render, notifier } = {}) {
    return {
      meta,
      host,                                        // 실제 host.mjs — verifyStored 교차검증을 그대로 쓴다
      now,
      sleep: async (n) => { slept.push(n); },
      notifier: notifier || (async (ev, p) => { alerts.push({ ev, p }); return { telegram: 'sent', discord: 'sent' }; }),
      render: render || (async () => { renderCalls++; return { ok: false, reason: '이 시나리오에서 재렌더는 일어나면 안 된다' }; }),
    };
  }
  function reset() { alerts = []; slept = []; renderCalls = 0; }

  /** 전이표대로만 목표 상태까지 몰고 간다(불법 지름길 없음). */
  const ORDER = ['planned', 'scripted', 'rendered', 'hosted', 'child_containers_partial',
    'carousel_container_created', 'publish_unknown', 'published'];
  function seed(postId, status, fields = {}, { heldFrom = 'hosted', heldReason = 'meta:media-fetch' } = {}) {
    const stop = status === 'held' ? heldFrom : status;
    for (const s of ORDER) {
      lib.transition(postId, s, s === stop ? fields : {});
      if (s === stop) break;
    }
    if (status === 'held') lib.transition(postId, 'held', { held_reason: heldReason });
    return lib.getPost(postId);
  }

  /** 7슬롯 전부 유효한 자식 컨테이너를 심는다(재사용 판정을 참으로 만드는 기본 상태). */
  const fullChildren = (prefix = 'c', at = nowIso()) => ({
    child_container_ids: Array.from({ length: 7 }, (_, i) => `${prefix}${i}`),
    child_created_at: Array.from({ length: 7 }, () => at),
  });

  // 불변식 ①②③ 누적 관측 — 시나리오마다 갱신한다.
  const INV = { maxPublishedOk: 0, maxIssued: 0, maxConfirmedFailed: 0 };
  function observe(meta, postId) {
    INV.maxPublishedOk = Math.max(INV.maxPublishedOk, meta.calls.publishedOk);
    const p = lib.getPost(postId);
    if (p) {
      INV.maxIssued = Math.max(INV.maxIssued, Number(p.publish_issued_count || 0));
      INV.maxConfirmedFailed = Math.max(INV.maxConfirmedFailed, Number(p.publish_confirmed_failed_count || 0));
    }
  }

  // ─── ① 해피패스 ────────────────────────────────────────────────────────────
  section('[1] 시나리오 1 — 해피패스(hosted 진입 → published)');
  {
    resetIndex(); reset();
    const P = 'cn-2026-08-01-happy00001';
    const a = artifacts(P);
    seed(P, 'hosted', { slide_sha256: a.sha, public_url: a.urls, caption: '캡션 본문 #cn20260801happy00001' });
    const meta = makeMeta();
    const r = await pub.publishPost(P, { cfg: CFG(), token: TOKEN, deps: deps(meta), fetchImpl: makeFetch() });

    eq('published', lib.getPost(P).status, 'published');
    eq('ok:true', r.ok, true);
    eq('자식 컨테이너 7회', meta.calls.createChildContainer, 7);
    eq('캐러셀 1회', meta.calls.createCarouselContainer, 1);
    eq('🔴 mediaPublish 정확히 1회', meta.calls.mediaPublish, 1);
    eq('publish_issued_count===1', lib.getPost(P).publish_issued_count, 1);
    eq('재렌더 0회(저장 산출물 재사용)', renderCalls, 0);
    ok('매칭키가 발행 전에 기록됐다(caption_sha256·idem_marker)',
      Boolean(lib.getPost(P).caption_sha256) && lib.getPost(P).idem_marker === lib.idemMarker(P));
    eq('carousel_children_key 가 자식 조합과 일치',
      lib.getPost(P).carousel_children_key, lib.getPost(P).child_container_ids.join(','));
    observe(meta, P);
  }

  // ─── ② 한도 차단 ───────────────────────────────────────────────────────────
  section('[2] 시나리오 2 — publishingLimit allowed:false → Meta 호출 0회');
  {
    resetIndex(); reset();
    const P = 'cn-2026-08-01-limit00001';
    const a = artifacts(P);
    seed(P, 'hosted', { slide_sha256: a.sha, public_url: a.urls });
    const meta = makeMeta({ guard: () => ({ ok: false, gate: 'limit', reason: 'quota 50/50' }) });
    const r = await pub.publishPost(P, { cfg: CFG(), token: TOKEN, deps: deps(meta), fetchImpl: makeFetch() });

    const p = lib.getPost(P);
    eq('held', p.status, 'held');
    ok('held_reason 이 limit: 으로 시작', p.held_reason.startsWith('limit:'), p.held_reason);
    eq('held_class=external(1-A 집계 제외)', p.held_class, 'external');
    eq('createChildContainer 0회', meta.calls.createChildContainer, 0);
    eq('mediaPublish 0회', meta.calls.mediaPublish, 0);
    eq('반환도 held 를 밝힌다', r.held, p.held_reason);
    observe(meta, P);
  }

  // ─── ③④ 부분 실패 → 재실행 시 per-slot 재사용 ─────────────────────────────
  section('[3] 시나리오 3·4 — 4번째 자식 5xx(백오프 전패) → 재실행 시 4회만 생성');
  {
    resetIndex(); reset();
    const P = 'cn-2026-08-01-partial001';
    const a = artifacts(P);
    seed(P, 'hosted', { slide_sha256: a.sha, public_url: a.urls });

    const meta1 = makeMeta({ child: (n) => (n >= 4 ? { ok: false, status: 503, error: 'transient', reason: 'HTTP 503' } : undefined) });
    await pub.publishPost(P, { cfg: CFG(), token: TOKEN, deps: deps(meta1), fetchImpl: makeFetch() });

    const p1 = lib.getPost(P);
    // ⚠ 계획 §7.3 3행은 "child_containers_partial"·"held_class=transient" 를 함께 적었지만
    //    한 포스트가 두 상태일 수는 없다. §3.14.3 step 4 의 절차(부분결과 flush → 상태를
    //    partial 로 표시 → held)를 정본으로 삼는다: **최종 상태는 held(transient)**,
    //    부분 진행은 필드와 history 에 남아 다음 런이 슬롯 단위로 이어받는다.
    eq('최종 상태는 held(§3.14.3 step 4)', p1.status, 'held');
    ok('부분완료가 history 에 기록됐다',
      p1.history.some(h => h.to === 'child_containers_partial'), JSON.stringify(p1.history.slice(-3)));
    eq('유효 id 3건(부분 결과 보존)', p1.child_container_ids.filter(Boolean).length, 3);
    eq('held_class=transient(sweep 이 24h 내 재시도)', p1.held_class, 'transient');
    eq('백오프 3회 소진 → 총 6회 호출(3성공 + 3재시도)', meta1.calls.createChildContainer, 6);
    eq('백오프 대기 2회(2s·4s)', slept.length, 2);
    ok('대기가 지수적으로 는다', slept[0] === 1 && slept[1] === 2, JSON.stringify(slept));
    eq('mediaPublish 0회', meta1.calls.mediaPublish, 0);
    observe(meta1, P);

    // ④ 재실행 — held(transient) 로 재진입해 나머지 4개만 만든다.
    reset();
    const meta2 = makeMeta();
    const r2 = await pub.publishPost(P, { cfg: CFG(), token: TOKEN, deps: deps(meta2), fetchImpl: makeFetch() });
    eq('🔴 createChildContainer 4회(1~3 재사용)', meta2.calls.createChildContainer, 4);
    eq('🔴 재렌더 0회', renderCalls, 0);
    eq('published 도달', lib.getPost(P).status, 'published');
    eq('mediaPublish 1회', meta2.calls.mediaPublish, 1);
    ok('되살아난 흔적(revived_at)', Boolean(lib.getPost(P).revived_at));
    eq('r.ok', r2.ok, true);
    observe(meta2, P);
  }

  // ─── ⑤′ URL↔sha 교차검증 실패 → 전면 재렌더 ───────────────────────────────
  section("[4] 시나리오 5′ — public_url[2] 변조 → url-sha-mismatch → 전면 재렌더 + 새 attempt");
  {
    resetIndex(); reset();
    const P = 'cn-2026-08-01-mismatch01';
    const a = artifacts(P);
    const mangled = [...a.urls];
    mangled[2] = mangled[2].replace(/\/03-[0-9a-f]{16}\.jpg$/, '/03-ffffffffffffffff.jpg'); // sha 와 어긋나게
    seed(P, 'child_containers_partial', {
      slide_sha256: a.sha, public_url: mangled, ...fullChildren('old'),
    });

    // (a) 결정론적 렌더 — 재렌더해도 6장은 같은 바이트라 같은 URL 로 돌아온다.
    let rendered = 0;
    const meta = makeMeta();
    const r = await pub.publishPost(P, {
      cfg: CFG(), token: TOKEN, fetchImpl: makeFetch(),
      deps: deps(meta, { render: async () => { rendered++; return { ok: true, sha: a.sha, urls: a.urls }; } }),
    });

    const p = lib.getPost(P);
    eq('전면 재렌더 1회', rendered, 1);
    eq('attempt_id 증가(전면 재렌더 시에만)', p.attempt_id, 'att-2');
    eq('public_url 이 sha 와 맞는 값으로 복구됨', p.public_url[2], a.urls[2]);
    eq('🔴 URL 이 달라진 슬롯 2 만 재생성', meta.calls.createChildContainer, 1);
    ok('슬롯 2 만 새 id, 나머지 6개는 재사용',
      p.child_container_ids[2] === 'child-1'
      && p.child_container_ids.filter((id, i) => i !== 2 && String(id).startsWith('old')).length === 6,
      JSON.stringify(p.child_container_ids));
    eq('throw 없이 published', p.status, 'published');
    eq('r.ok', r.ok, true);
    observe(meta, P);

    // (b) 🔴 자기참조 회귀 가드 — 재렌더 결과가 **다른 바이트**면 7개 전부 무효여야 한다.
    //     step 3 이 새 sha·URL 을 post 에 쓴 뒤 그 post 로 슬롯을 판정하면 저장값 vs 저장값
    //     비교가 되어 항상 참이 되고, 예전 컨테이너(=옛 이미지)가 그대로 발행된다.
    resetIndex(); reset();
    const Q = 'cn-2026-08-01-rerender02';
    const b = artifacts(Q);
    const v2sha = [], v2urls = [];
    for (let i = 0; i < 7; i++) {
      const s2 = lib.sha256(`${Q}#slide${i}#v2`);
      v2sha.push(s2); v2urls.push(host.publicUrl('cardnews', host.objectPath(Q, i, s2)));
    }
    seed(Q, 'child_containers_partial', {
      slide_sha256: b.sha, public_url: b.urls.map((u, i) => (i === 0 ? u.replace(/\/01-[0-9a-f]{16}\./, '/01-0000000000000000.') : u)),
      ...fullChildren('stale'),
    });
    const meta2 = makeMeta();
    await pub.publishPost(Q, {
      cfg: CFG(), token: TOKEN, fetchImpl: makeFetch(),
      deps: deps(meta2, { render: async () => ({ ok: true, sha: v2sha, urls: v2urls }) }),
    });
    const q = lib.getPost(Q);
    eq('🔴 산출물이 통째로 바뀌면 7개 전부 재생성', meta2.calls.createChildContainer, 7);
    ok('예전(stale) 컨테이너 id 는 하나도 남지 않는다',
      !q.child_container_ids.some(id => String(id).startsWith('stale')), JSON.stringify(q.child_container_ids));
    eq('published', q.status, 'published');
    observe(meta2, Q);
  }

  // ─── ⑥ TTL 20h — 슬롯 0만 만료 ─────────────────────────────────────────────
  section('[5] 시나리오 6 — child_created_at[0] 이 21h 전 → 슬롯 0만 재생성(TTL 20h)');
  {
    resetIndex(); reset();
    const P = 'cn-2026-08-01-ttl0000001';
    const a = artifacts(P);
    const kids = fullChildren('keep');
    kids.child_created_at[0] = new Date(CLOCK.getTime() - 21 * 3600000).toISOString();
    seed(P, 'child_containers_partial', { slide_sha256: a.sha, public_url: a.urls, ...kids });

    const meta = makeMeta();
    await pub.publishPost(P, { cfg: CFG(), token: TOKEN, deps: deps(meta), fetchImpl: makeFetch() });

    const p = lib.getPost(P);
    eq('🔴 슬롯 0만 재생성(1회)', meta.calls.createChildContainer, 1);
    ok('슬롯 0 은 새 id', p.child_container_ids[0] === 'child-1', p.child_container_ids[0]);
    ok('슬롯 1~6 은 그대로', p.child_container_ids.slice(1).every((id, i) => id === `keep${i + 1}`), JSON.stringify(p.child_container_ids));
    ok('19h 전은 아직 유효(경계 확인)',
      pub.slotValid({ ...p, child_created_at: p.child_created_at.map(() => new Date(CLOCK.getTime() - 19 * 3600000).toISOString()) },
        1, a.sha, a.urls, CLOCK, CFG()));
    eq('published', p.status, 'published');
    observe(meta, P);
  }

  // ─── ⑦ AbortError → publish_unknown, 재시도 0회 ────────────────────────────
  section('[6] 시나리오 7 — mediaPublish AbortError → publish_unknown · 재시도 0회');
  const UNK = 'cn-2026-08-01-unknown001';
  {
    resetIndex(); reset();
    const a = artifacts(UNK);
    seed(UNK, 'hosted', { slide_sha256: a.sha, public_url: a.urls, caption: '캡션' });
    const meta = makeMeta({ publish: () => ({ ok: false, outcome: 'unknown', reason: '네트워크/타임아웃: aborted' }) });
    const r = await pub.publishPost(UNK, { cfg: CFG(), token: TOKEN, deps: deps(meta), fetchImpl: makeFetch() });

    const p = lib.getPost(UNK);
    eq('publish_unknown 유지', p.status, 'publish_unknown');
    eq('🔴 mediaPublish 1회 — 재시도 없음', meta.calls.mediaPublish, 1);
    eq('publish_issued_count===1', p.publish_issued_count, 1);
    eq('confirmed_failed 는 아직 0(시도≠확정실패)', p.publish_confirmed_failed_count, 0);
    ok('write-ahead 로 요청 시각·reconcile_after 가 남았다',
      Boolean(p.publish_requested_at) && Boolean(p.reconcile_after));
    eq('reconcile_after = 요청 + 45초',
      Date.parse(p.reconcile_after) - Date.parse(p.publish_requested_at), 45000);
    eq('reconcile 은 아직 안 했다', meta.calls.findPublished, 0);
    eq('경보 1건(사람이 알아야 한다)', alerts.length, 1);
    eq('반환 state', r.state, 'publish_unknown');
    observe(meta, UNK);
  }

  /** ⑦ 이후 상태를 그대로 복제해 여러 후속 시나리오를 같은 출발점에서 돌린다. */
  const unknownSnapshot = JSON.parse(JSON.stringify(lib.getPost(UNK)));
  const restoreUnknown = (id = UNK) => {
    const idx = lib.loadIndex();
    idx[id] = { ...JSON.parse(JSON.stringify(unknownSnapshot)), post_id: id };
    lib.saveIndexAtomic(idx);
    return idx[id];
  };

  // ─── ⑧ reconcile 이 발행분을 찾아냄 ────────────────────────────────────────
  section('[7] 시나리오 8 — 재실행 + findPublished 가 mediaId 반환 → 중복 없음');
  {
    reset();
    restoreUnknown();
    const meta = makeMeta({ find: () => ({ ok: true, mediaId: 'media-existing', matchedBy: 'marker' }) });
    shift(60000);   // reconcile_after 를 지난 뒤 재실행
    const r = await pub.publishPost(UNK, { cfg: CFG(), token: TOKEN, deps: deps(meta), fetchImpl: makeFetch() });

    const p = lib.getPost(UNK);
    eq('published', p.status, 'published');
    eq('reconciled:true', p.reconciled, true);
    eq('published_media_id 는 찾아낸 것', p.published_media_id, 'media-existing');
    eq('🔴 mediaPublish 추가 0회 — 중복 없음 증명', meta.calls.mediaPublish, 0);
    eq('publish_issued_count 그대로 1', p.publish_issued_count, 1);
    eq('자식·캐러셀도 다시 만들지 않는다', meta.calls.createChildContainer + meta.calls.createCarouselContainer, 0);
    eq('r.ok', r.ok, true);
    // 매칭 창은 양쪽 스큐 — 한쪽만 주면 경계에서 오판한다.
    const f = meta.calls.lastFind;
    const req = Date.parse(p.publish_requested_at);
    eq('since = 요청 - 30분', Date.parse(f.since), req - 1800000);
    eq('newerTs = 요청 + 30분', Date.parse(f.newerTs), req + 1800000);
    eq('마커를 주 키로 넘긴다', f.idemMarker, p.idem_marker);
    ok('캡션 sha 폴백 키도 함께', typeof f.captionSha === 'string' && f.captionSha.length === 64, f.captionSha);
    observe(meta, UNK);
  }

  // ─── ⑨ 조회 자체가 실패 ────────────────────────────────────────────────────
  section('[8] 시나리오 9 — findPublished {ok:false} → publish_unknown 유지 + 경보');
  {
    reset();
    restoreUnknown();
    const meta = makeMeta({ find: () => ({ ok: false, reason: 'HTTP 500' }) });
    const r = await pub.publishPost(UNK, { cfg: CFG(), token: TOKEN, deps: deps(meta), fetchImpl: makeFetch() });

    eq('상태 유지(추측하지 않는다)', lib.getPost(UNK).status, 'publish_unknown');
    eq('🔴 mediaPublish 0회', meta.calls.mediaPublish, 0);
    eq('경보 1건', alerts.length, 1);
    ok('경보 이벤트가 publish-unknown 계열', alerts[0].ev.includes('PUBLISH_UNKNOWN'), alerts[0].ev);
    eq('ok:false', r.ok, false);
    observe(meta, UNK);
  }

  // ─── ⑩ ambiguous ──────────────────────────────────────────────────────────
  section('[9] 시나리오 10 — ambiguous → held + 경보 · 재발행 없음');
  {
    reset();
    restoreUnknown();
    const meta = makeMeta({ find: () => ({ ok: true, mediaId: null, ambiguous: true }) });
    await pub.publishPost(UNK, { cfg: CFG(), token: TOKEN, deps: deps(meta), fetchImpl: makeFetch() });

    const p = lib.getPost(UNK);
    eq('held', p.status, 'held');
    eq('held_reason', p.held_reason, 'reconcile:ambiguous');
    eq('held_class=permanent(사람 판단 전까지 자동 재시도 금지)', p.held_class, 'permanent');
    eq('🔴 mediaPublish 0회', meta.calls.mediaPublish, 0);
    eq('경보 1건', alerts.length, 1);
    observe(meta, UNK);
  }

  // ─── ⑪ 4xx 인데 실제로는 발행됨 ────────────────────────────────────────────
  section('[10] 시나리오 11 — mediaPublish 400(실제로는 발행됨) → reconcile 경유 확정');
  {
    resetIndex(); reset();
    const P = 'cn-2026-08-01-rejected01';
    const a = artifacts(P);
    seed(P, 'hosted', { slide_sha256: a.sha, public_url: a.urls, caption: '캡션' });
    const meta = makeMeta({
      publish: () => ({ ok: false, outcome: 'rejected', status: 400, reason: 'unknown' }),
      find: () => ({ ok: true, mediaId: 'media-actually-published', matchedBy: 'marker' }),
    });
    const r = await pub.publishPost(P, { cfg: CFG(), token: TOKEN, deps: deps(meta), fetchImpl: makeFetch() });

    const p = lib.getPost(P);
    eq('🔴 4xx 도 held 가 아니라 확인 후 published', p.status, 'published');
    eq('reconciled:true', p.reconciled, true);
    eq('published_media_id', p.published_media_id, 'media-actually-published');
    eq('mediaPublish 총 1회(재시도 없음)', meta.calls.mediaPublish, 1);
    eq('reconcile 1회', meta.calls.findPublished, 1);
    eq('r.ok', r.ok, true);
    observe(meta, P);
  }

  // ─── ⑫ publish.enabled=false ──────────────────────────────────────────────
  section('[11] 시나리오 12 — publish.enabled=false → 가드가 앞에서 막는다');
  {
    resetIndex(); reset();
    const P = 'cn-2026-08-01-disabled01';
    const a = artifacts(P);
    seed(P, 'hosted', { slide_sha256: a.sha, public_url: a.urls });

    // 🔴 여기서는 가드를 스텁하지 않는다 — **실제 guardPublish** 가 publish.enabled 를 본다.
    const cfg = CFG(); cfg.publish.enabled = false;
    let netCalls = 0;
    const spy = makeMeta();
    const realGuardMeta = Object.assign(Object.create(spy), {
      guardPublish: (c, t, o) => { spy.calls.guardPublish++; return metaMod.guardPublish(c, t, o); },
    });
    const r = await pub.publishPost(P, {
      cfg, token: TOKEN, deps: deps(realGuardMeta),
      fetchImpl: async (...args) => { netCalls++; return makeFetch()(...args); },
    });

    const p = lib.getPost(P);
    eq('held', p.status, 'held');
    ok('🔴 held_reason 이 readiness: 로 시작', p.held_reason.startsWith('readiness:'), p.held_reason);
    ok('사유가 마스터 스위치를 지목', p.held_reason.includes('publish.enabled=false'), p.held_reason);
    eq('held_class=external', p.held_class, 'external');
    eq('createChildContainer 0회', spy.calls.createChildContainer, 0);
    eq('mediaPublish 0회', spy.calls.mediaPublish, 0);
    eq('한도 조회 네트워크도 0회', netCalls, 0);
    eq('ok:false', r.ok, false);
    observe(realGuardMeta, P);
  }

  // ─── ⑭ 확정 미발행 재도달 — 재발행 게이트 소진 ────────────────────────────
  section('[12] 시나리오 14 — confirmed_failed===1 에서 확정 미발행 재도달 → retry-exhausted');
  {
    reset();
    const P = 'cn-2026-08-01-exhaust001';
    restoreUnknown(P);
    lib.flush(P, { publish_confirmed_failed_count: 1 });
    const meta = makeMeta({ find: () => ({ ok: true, mediaId: null, ambiguous: false }) });
    await pub.publishPost(P, { cfg: CFG(), token: TOKEN, deps: deps(meta), fetchImpl: makeFetch() });

    const p = lib.getPost(P);
    eq('held', p.status, 'held');
    eq('held_reason', p.held_reason, 'publish:retry-exhausted');
    eq('🔴 mediaPublish 0회', meta.calls.mediaPublish, 0);
    eq('confirmed_failed 는 상한 그대로 1', p.publish_confirmed_failed_count, 1);
    observe(meta, P);
  }

  // ─── ⑲ 확정 미발행 → 정확히 1회 재발행 ────────────────────────────────────
  section('[13] 시나리오 19 — 확정 미발행(ambiguous 아님) → 정확히 1회 재발행');
  {
    reset();
    const P = 'cn-2026-08-01-republish1';
    restoreUnknown(P);
    const meta = makeMeta({ find: () => ({ ok: true, mediaId: null, ambiguous: false }) });
    const r = await pub.publishPost(P, { cfg: CFG(), token: TOKEN, deps: deps(meta), fetchImpl: makeFetch() });

    const p = lib.getPost(P);
    eq('published', p.status, 'published');
    eq('🔴 재발행 정확히 1회', meta.calls.mediaPublish, 1);
    eq('publish_confirmed_failed_count===1', p.publish_confirmed_failed_count, 1);
    eq('publish_issued_count===2(1회차 unknown + 재발행)', p.publish_issued_count, 2);
    eq('r.ok', r.ok, true);
    ok('🔴 두 카운터가 분리돼 있다 — 시도 카운터만 있었다면 이 분기는 도달 불가였다',
      p.publish_issued_count !== p.publish_confirmed_failed_count);
    ok('가드를 통과한 발행만 있었다', meta.calls.guardPublish >= 1, `guard=${meta.calls.guardPublish}`);
    eq('no-guard 로 거부된 호출 0건', meta.calls.noGuard, 0);
    observe(meta, P);
  }

  // ─── 1회용 가드 — 한 런 안에서 두 번 발행하면 새 가드가 필요하다 ─────────
  section('[13b] 소비된 가드는 재사용되지 않는다(rejected → reconcile → 재발행, 한 런)');
  {
    resetIndex(); reset();
    const P = 'cn-2026-08-01-guardspent';
    const a = artifacts(P);
    seed(P, 'hosted', { slide_sha256: a.sha, public_url: a.urls, caption: '캡션' });
    const meta = makeMeta({
      publish: (n) => (n === 1 ? { ok: false, outcome: 'rejected', status: 400, reason: 'unknown' } : undefined),
      find: () => ({ ok: true, mediaId: null, ambiguous: false }),
    });
    await pub.publishPost(P, { cfg: CFG(), token: TOKEN, deps: deps(meta), fetchImpl: makeFetch() });

    const p = lib.getPost(P);
    eq('published', p.status, 'published');
    eq('mediaPublish 2회(1차 rejected + 확정 미발행 후 재발행)', meta.calls.mediaPublish, 2);
    eq('🔴 no-guard 거부 0건 — 소비된 토큰을 재사용하지 않았다', meta.calls.noGuard, 0);
    ok('🔴 두 번째 발행 전에 가드를 새로 받았다', meta.calls.guardPublish >= 2, `guard=${meta.calls.guardPublish}`);
    eq('confirmed_failed 1', p.publish_confirmed_failed_count, 1);
    eq('issued 2', p.publish_issued_count, 2);
    observe(meta, P);
  }

  // ─── 발행 폭주 백스톱 ─────────────────────────────────────────────────────
  section('[14] publish_issued_count 상한 3 — 폭주 백스톱');
  {
    reset();
    const P = 'cn-2026-08-01-issuecap01';
    restoreUnknown(P);
    lib.flush(P, { publish_issued_count: 3, publish_confirmed_failed_count: 0 });
    const meta = makeMeta({ find: () => ({ ok: true, mediaId: null, ambiguous: false }) });
    await pub.publishPost(P, { cfg: CFG(), token: TOKEN, deps: deps(meta), fetchImpl: makeFetch() });

    const p = lib.getPost(P);
    eq('held', p.status, 'held');
    eq('held_reason', p.held_reason, 'publish:issue-cap');
    eq('🔴 mediaPublish 0회', meta.calls.mediaPublish, 0);
    eq('카운터가 상한을 넘지 않는다', p.publish_issued_count, 3);
    observe(meta, P);
  }

  // ─── ㉓ 백오프 재시도 성공 ────────────────────────────────────────────────
  section('[15] 시나리오 23 — withBackoff 2회 실패 후 3회차 성공');
  {
    resetIndex(); reset();
    const P = 'cn-2026-08-01-backoff001';
    const a = artifacts(P);
    seed(P, 'hosted', { slide_sha256: a.sha, public_url: a.urls });
    const meta = makeMeta({ child: (n) => (n <= 2 ? { ok: false, status: 503, error: 'transient', reason: 'HTTP 503' } : undefined) });
    await pub.publishPost(P, { cfg: CFG(), token: TOKEN, deps: deps(meta), fetchImpl: makeFetch() });

    const p = lib.getPost(P);
    eq('슬롯 0 은 3회차에 성공 → 총 9회(2재시도 + 7슬롯)', meta.calls.createChildContainer, 9);
    ok('슬롯 0 채워짐', Boolean(p.child_container_ids[0]));
    eq('published 도달', p.status, 'published');
    eq('백오프 대기 2회', slept.length, 2);
    observe(meta, P);
  }

  // ─── 재시도해도 낫지 않는 오류는 백오프하지 않는다 ────────────────────────
  section('[16] token-expired 는 재시도하지 않는다(즉시 held + 재인증 경보)');
  {
    resetIndex(); reset();
    const P = 'cn-2026-08-01-tokenexp01';
    const a = artifacts(P);
    seed(P, 'hosted', { slide_sha256: a.sha, public_url: a.urls });
    const meta = makeMeta({ child: () => ({ ok: false, status: 400, error: 'token-expired', reason: 'HTTP 400' }) });
    await pub.publishPost(P, { cfg: CFG(), token: TOKEN, deps: deps(meta), fetchImpl: makeFetch() });

    const p = lib.getPost(P);
    eq('🔴 재시도 없이 1회로 끝', meta.calls.createChildContainer, 1);
    eq('백오프 대기 0회', slept.length, 0);
    eq('held_reason', p.held_reason, 'meta:token-expired');
    eq('held_class=external(사람 재인증)', p.held_class, 'external');
    ok('재인증 경보 발송', alerts.some(x => x.ev === 'CARDNEWS_TOKEN_EXPIRED'), JSON.stringify(alerts));
    observe(meta, P);
  }

  // ─── liveness(R17) ────────────────────────────────────────────────────────
  section('[17] confirmLive — 발행 성공 ≠ 노출. 확인만 하고 상태는 안 바꾼다');
  {
    resetIndex(); reset();
    const P = 'cn-2026-08-01-liveness01';
    const a = artifacts(P);
    seed(P, 'hosted', { slide_sha256: a.sha, public_url: a.urls });
    const cfg = CFG(); cfg.meta.liveness_check = true;
    const meta = makeMeta({ media: () => ({ ok: false, reason: 'HTTP 404' }) });
    await pub.publishPost(P, { cfg, token: TOKEN, deps: deps(meta), fetchImpl: makeFetch() });

    const p = lib.getPost(P);
    eq('getMedia 1회', meta.calls.getMedia, 1);
    eq('🔴 상태는 published 그대로', p.status, 'published');
    eq('liveness 만 unconfirmed 로 기록', p.liveness, 'unconfirmed');
    ok('경보 발송', alerts.length >= 1);
    observe(meta, P);

    reset();
    const P2 = 'cn-2026-08-01-liveness02';
    const a2 = artifacts(P2);
    seed(P2, 'hosted', { slide_sha256: a2.sha, public_url: a2.urls });
    const meta2 = makeMeta();
    await pub.publishPost(P2, { cfg, token: TOKEN, deps: deps(meta2), fetchImpl: makeFetch() });
    const p2 = lib.getPost(P2);
    eq('정상 확인 시 confirmed', p2.liveness, 'confirmed');
    ok('permalink 기록', String(p2.permalink).includes('/p/'), p2.permalink);
    observe(meta2, P2);
  }

  // ─── held 회복 경로 2개뿐 ─────────────────────────────────────────────────
  section('[18] held 회복 — transient + 산출물 생존일 때만. 산출물 소실은 익일 새 post_id');
  {
    resetIndex(); reset();
    const P = 'cn-2026-08-01-heldperm01';
    const a = artifacts(P);
    seed(P, 'held', { slide_sha256: a.sha, public_url: a.urls }, { heldReason: 'gate:generalization' });
    eq('permanent 로 분류됨', lib.getPost(P).held_class, 'permanent');
    const meta = makeMeta();
    const r = await pub.publishPost(P, { cfg: CFG(), token: TOKEN, deps: deps(meta), fetchImpl: makeFetch() });
    eq('permanent held 는 되살아나지 않는다', r.reason, 'held:permanent');
    eq('상태 그대로 held', lib.getPost(P).status, 'held');
    eq('Meta 발행 호출 0회', meta.calls.createChildContainer + meta.calls.mediaPublish, 0);

    // transient 이지만 산출물이 사라진 경우 — 두 번째 회복 경로를 만들지 않는다.
    reset();
    const Q = 'cn-2026-08-01-heldgone01';
    const b = artifacts(Q);
    seed(Q, 'held', { slide_sha256: b.sha, public_url: b.urls }, { heldReason: 'meta:media-fetch' });
    const meta2 = makeMeta();
    const r2 = await pub.publishPost(Q, {
      cfg: CFG(), token: TOKEN, deps: deps(meta2), fetchImpl: makeFetch(new Set([b.urls[3]])),
    });
    eq('산출물 소실 → held:artifacts-gone', r2.reason, 'held:artifacts-gone');
    eq('상태는 held 그대로(익일 새 post_id 로 재선정)', lib.getPost(Q).status, 'held');
    eq('재렌더도 하지 않는다(두 번째 회복 경로 없음)', renderCalls, 0);
    eq('Meta 발행 호출 0회', meta2.calls.createChildContainer + meta2.calls.mediaPublish, 0);
  }

  // ─── ⑱ 6상태 직접 진입 ────────────────────────────────────────────────────
  section('[19] 🔴 시나리오 18 — sweep 대상 6상태 각각으로 publishPost 직접 진입');
  {
    const ENTRIES = ['rendered', 'hosted', 'child_containers_partial', 'carousel_container_created',
      'publish_unknown', 'held'];
    eq('시나리오 집합이 sweep 대상 집합과 일치',
      JSON.stringify([...pub.SWEEP_STATES, 'held']), JSON.stringify(ENTRIES));

    const bad = [];
    for (const st of ENTRIES) {
      resetIndex(); reset();
      const P = `cn-2026-08-01-e${st.slice(0, 9).replace(/_/g, '')}`.slice(0, 25);
      const a = artifacts(P);
      const base = { slide_sha256: a.sha, public_url: a.urls, caption: '캡션' };
      let fields = { ...base };
      if (st === 'child_containers_partial') {
        fields = { ...base, child_container_ids: ['x0', 'x1', 'x2', null, null, null, null],
          child_created_at: [nowIso(), nowIso(), nowIso(), null, null, null, null] };
      } else if (st === 'carousel_container_created' || st === 'publish_unknown') {
        const kids = fullChildren('k');
        fields = { ...base, ...kids, carousel_container_id: 'car-1', carousel_created_at: nowIso(),
          carousel_children_key: kids.child_container_ids.join(','),
          caption_sha256: lib.sha256(lib.normalizeCaption('캡션').slice(0, 200)), idem_marker: lib.idemMarker(P) };
        if (st === 'publish_unknown') {
          fields.publish_requested_at = nowIso();
          fields.reconcile_after = new Date(CLOCK.getTime() + 45000).toISOString();
          fields.publish_issued_count = 1;
        }
      }
      seed(P, st, fields, { heldReason: 'meta:media-fetch' });

      const meta = makeMeta({ find: () => ({ ok: true, mediaId: `found-${st}`, matchedBy: 'marker' }) });
      let threw = null, res = null;
      try {
        res = await pub.publishPost(P, { cfg: CFG(), token: TOKEN, deps: deps(meta), fetchImpl: makeFetch() });
      } catch (e) { threw = e; }
      const p = lib.getPost(P);
      if (threw) bad.push(`${st}: throw ${threw.message}`);
      else if (p.status !== 'published') bad.push(`${st}: status=${p.status} (${p.held_reason || res?.reason || ''})`);
      observe(meta, P);
    }
    ok('🔴 6상태 전부 throw 없이 published 까지 진행', bad.length === 0, bad.join(' / '));
  }

  // ─── 불변식 (§3.14.6) ─────────────────────────────────────────────────────
  section('[20] 불변식 4개(§3.14.6)');
  eq('① 포스트당 성공한 mediaPublish ≤ 1', INV.maxPublishedOk <= 1, true);
  eq('② publish_issued_count ≤ 3', INV.maxIssued <= 3, true);
  eq('③ publish_confirmed_failed_count ≤ 1', INV.maxConfirmedFailed <= 1, true);
  ok('④ 가드 없는 mediaPublish 는 항상 {ok:false} — 실제 모듈로 증명',
    (await metaMod.mediaPublish({ ig_user_id: 'x' }, { creationId: 'c' }, {
      fetchImpl: async () => { throw new Error('여기 오면 안 된다'); },
    })).reason === 'no-guard');
});

// ─── ⬇ 2부(Step 4b 폴트 인젝션 §7.3)는 이 줄 **위에** part(2, …) 로 추가한다 ──

// ═══ 러너 ═════════════════════════════════════════════════════════════════════

const wantArg = process.argv.find(a => a.startsWith('--part='));
const want = Number(wantArg ? wantArg.slice(7) : (process.env.CARDNEWS_TEST_PART || 0)) || 0;
const selected = PARTS.filter(p => !want || p.n === want);

if (!selected.length) {
  console.error(`실행할 파트가 없다 — 요청=${want}, 정의된 파트=[${PARTS.map(p => p.n).join(',')}]`);
  rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
}

try {
  for (const p of selected) {
    console.log(`\n═══ ${p.n}부 — ${p.name} ═══`);
    await p.fn();
  }
} catch (e) {
  console.error(`\n[ERROR] 테스트 실행 중 예외: ${e.stack || e.message}`);
  failN++;
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n결과: ${passN} PASS / ${failN} FAIL`);
process.exit(failN === 0 ? 0 : 1);
