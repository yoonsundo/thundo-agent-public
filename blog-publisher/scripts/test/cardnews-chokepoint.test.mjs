#!/usr/bin/env node
/**
 * cardnews-chokepoint.test.mjs — 🔴 발행 초크포인트 (계획 §3.13.1 · Step 4b)
 *
 * 이 테스트가 존재하는 이유: 발행 차단 스위치가 계획 개정 3회 연속으로 "그 검사를 잊은 새 코드
 * 경로"에 의해 우회됐다. 그래서 검사를 **런타임**으로 올렸고, 여기서 그 성질을 확인한다.
 *
 * 4중 강제 중 이 파일이 맡는 것:
 *  ① 런타임(주) — 가드 토큰 없으면 `mediaPublish` 가 `{ok:false, reason:'no-guard'}`
 *  ② 1회용 — 소비된 토큰 replay 불가
 *  ③ 자체 호출 — `issuePublish` 가 가드를 못 받으면 스스로 발급한다(호출자가 잊을 수 없다)
 *  ④ 린트(보조·조기경보) — 발행 호출 지점 수를 센다
 *
 * 🔴 **시나리오 28**(§3.13.1 알려진 한계 2): 폴트 인젝션들은 스텁 `deps.meta` 를 주입하므로
 * 그 "mediaPublish 0회" 단언은 **호출자 규율을 증명하지, 게이트 자체를 증명하지 않는다.**
 * 여기서는 **실제 `meta.mjs` + 스텁 `fetchImpl`** 로 그 이음매를 닫는다: `publish.enabled=false`
 * 에서 `mediaPublish` 를 직접 불러 `reason:'no-guard'` 를 확인하고, **`fetchImpl` 이 한 번도
 * 불리지 않았음**을 단언한다(거부가 네트워크 *이전*에 일어난다).
 *
 * 네트워크 없음 · 크리덴셜 없음 · 실제 발행 없음. exit 0 = 전체 통과.
 */
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP = mkdtempSync(join(tmpdir(), 'cardnews-choke-'));
process.env.STATE_DIR_OVERRIDE = TMP;     // 실 state/ 격리 — import 전에 세팅
process.env.RUN_MODE = 'mock';
const CFG_PATH = join(TMP, 'cardnews.json');
writeFileSync(CFG_PATH, JSON.stringify({
  schema: 'cardnews/v1', channel: {}, cards: { count: 7 },
  meta: { container_ttl_ms: 72000000, max_publish_issued: 3 },
  publish: { enabled: false },                       // 🔴 이 테스트는 항상 차단 상태에서 돈다
}), 'utf8');
process.env.CARDNEWS_CONFIG_OVERRIDE = CFG_PATH;

const meta = await import('../cardnews/meta.mjs');
const pub = await import('../cardnews/publish.mjs');
const lib = await import('../cardnews/lib.mjs');

const CARDNEWS_DIR = fileURLToPath(new URL('../cardnews/', import.meta.url));

let passN = 0, failN = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { console.log(`  [PASS] ${label}`); passN++; }
  else { console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`); failN++; }
};
const eq = (label, got, want) => ok(label, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

const TOKEN = { ig_user_id: '178414', access_token: 'stub', issued_at: 'x', expires_at: 'y' };
const resp = (status, body) => ({ status, json: async () => body, text: async () => JSON.stringify(body ?? {}) });
const CFG_OFF = JSON.parse(readFileSync(CFG_PATH, 'utf8'));
const CFG_ON = { ...CFG_OFF, publish: { enabled: true } };

// ═══ 시나리오 28 — 실제 모듈 + 스텁 fetch, publish.enabled=false ═════════════
console.log('\n[28] 🔴 실제 meta.mjs + 스텁 fetchImpl — 게이트 자체를 증명한다');
{
  let fetchCalls = 0;
  const fetchImpl = async (...args) => {
    fetchCalls++;
    return resp(200, { id: '이 응답이 쓰이면 이미 발행이 나간 것이다', args });
  };

  // ① 가드 발급 자체가 막힌다 — publish.enabled=false 는 무인 발행 마스터 스위치.
  const g = await meta.guardPublish(CFG_OFF, TOKEN, { fetchImpl });
  eq('guardPublish ok:false', g.ok, false);
  eq('gate:readiness', g.gate, 'readiness');
  ok('사유가 마스터 스위치를 지목', String(g.reason).includes('publish.enabled=false'), g.reason);
  eq('가드 토큰 미발급', g.guardToken, undefined);
  eq('🔴 이 시점까지 fetch 0회(한도 조회조차 안 한다)', fetchCalls, 0);

  // ② 그 상태로 mediaPublish 를 **직접** 호출한다 — 상위 로직을 통째로 건너뛴 최악의 경로.
  const r = await meta.mediaPublish(TOKEN, { creationId: 'carousel-1', guardToken: g.guardToken }, { fetchImpl });
  eq('ok:false', r.ok, false);
  eq('outcome:rejected', r.outcome, 'rejected');
  eq("🔴 reason:'no-guard'", r.reason, 'no-guard');
  eq('🔴 fetchImpl 은 단 한 번도 불리지 않았다(거부가 네트워크 이전)', fetchCalls, 0);

  // ③ 아무 객체나 토큰인 척해도 통하지 않는다(가드는 이 모듈 밖에서 만들 수 없다).
  const forged = await meta.mediaPublish(TOKEN, { creationId: 'c', guardToken: { id: 'forged', issuedAt: Date.now() } }, { fetchImpl });
  eq('위조 가드 거부', forged.reason, 'no-guard');
  eq('여전히 fetch 0회', fetchCalls, 0);

  // ④ 가드 원장은 export 되지 않는다 — 모듈 밖에서 넣을 방법이 없어야 한다.
  const exported = Object.keys(meta);
  ok('_activeGuards 는 export 되지 않는다', !exported.some(k => /guards?/i.test(k) && k !== 'guardPublish'),
    exported.join(','));
}

// ═══ 1회용 · replay ═══════════════════════════════════════════════════════════
console.log('\n[2] 1회용 토큰 — 소비 후 replay 불가');
{
  const limitOk = async () => resp(200, { data: [{ config: { quota_total: 50 }, quota_usage: 0 }] });
  const g = await meta.guardPublish(CFG_ON, TOKEN, { fetchImpl: limitOk });
  ok('한도 통과 시 가드 발급', g.ok === true && typeof g.guardToken.id === 'string');

  let publishCalls = 0;
  const fetchImpl = async () => { publishCalls++; return resp(200, { id: 'media-1' }); };
  const first = await meta.mediaPublish(TOKEN, { creationId: 'c', guardToken: g.guardToken }, { fetchImpl });
  eq('1회차 발행 성공', first.ok, true);
  eq('네트워크 1회', publishCalls, 1);

  const second = await meta.mediaPublish(TOKEN, { creationId: 'c', guardToken: g.guardToken }, { fetchImpl });
  eq('🔴 같은 토큰 replay → no-guard', second.reason, 'no-guard');
  eq('🔴 replay 는 네트워크를 늘리지 않는다', publishCalls, 1);
}

// ═══ ③층 — issuePublish 는 가드를 스스로 받는다 ═══════════════════════════════
console.log('\n[3] issuePublish 자체 호출 — 호출자가 가드를 잊을 수 없다');
{
  // publish.mjs 를 **가드 없이** 호출한다. 내부에서 실제 guardPublish 가 불려 차단돼야 한다.
  const P = 'cn-2026-08-01-choke00001';
  lib.transition(P, 'planned');
  lib.transition(P, 'scripted');
  lib.transition(P, 'rendered');
  lib.transition(P, 'hosted', { carousel_container_id: 'car-1' });

  let guardCalls = 0, publishCalls = 0;
  const spyMeta = {
    guardPublish: (cfg, token, o) => { guardCalls++; return meta.guardPublish(cfg, token, o); },
    mediaPublish: (...a) => { publishCalls++; return meta.mediaPublish(...a); },
    createChildContainer: async () => { throw new Error('여기 오면 안 된다'); },
    createCarouselContainer: async () => { throw new Error('여기 오면 안 된다'); },
    findPublished: async () => ({ ok: true, mediaId: null, ambiguous: false }),
    getMedia: async () => ({ ok: true }),
    classifyMetaError: meta.classifyMetaError,
  };
  const post = lib.getPost(P);
  const r = await pub.issuePublish(post, undefined, undefined, {
    cfg: CFG_OFF, token: TOKEN,
    deps: { meta: spyMeta, now: () => new Date('2026-08-01T02:00:00.000Z'), sleep: async () => {} },
    fetchImpl: async () => { throw new Error('네트워크를 타면 안 된다'); },
  });
  eq('가드를 스스로 발급 시도했다', guardCalls, 1);
  eq('🔴 mediaPublish 는 아예 불리지 않았다', publishCalls, 0);
  eq('결과는 held', r.state, 'held');
  ok('held_reason 이 readiness:', String(r.held).startsWith('readiness:'), r.held);
  eq('상태도 held', lib.getPost(P).status, 'held');
  eq('publish_issued_count 은 증가하지 않았다', lib.getPost(P).publish_issued_count, 0);

  // sweepUnresolved 도 자기 step 0 에서 가드를 받는다 — reconcile 이 재발행할 수 있으므로.
  const r2 = await pub.sweepUnresolved({
    cfg: CFG_OFF, token: TOKEN,
    deps: { meta: spyMeta, now: () => new Date('2026-08-01T02:00:00.000Z'), sleep: async () => {} },
  });
  eq('sweep 도 readiness 에서 멈춘다', r2.skipped, 'readiness');
  eq('sweep 이 훑은 건수 0', r2.swept.length, 0);
  eq('mediaPublish 여전히 0회', publishCalls, 0);
}

// ═══ ④층 — 린트(보조·조기경보) ═══════════════════════════════════════════════
console.log('\n[4] 린트(보조) — 발행 호출 지점 수 · 스파이크 미참조');
{
  const files = readdirSync(CARDNEWS_DIR).filter(f => f.endsWith('.mjs'));   // ⚠ 비재귀 — spike/ 제외
  const hits = [];
  for (const f of files) {
    const lines = readFileSync(join(CARDNEWS_DIR, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!line.includes('mediaPublish')) return;
      // 주석은 아무것도 발행하지 못한다 — 코드 라인만 센다.
      // ⚠ 계획 §7.1 의 `grep -c` 임계값 2는 이미 lib.mjs 의 산문 주석 1줄이 먹고 있다.
      //    문자열 카운트가 아니라 **코드 라인 카운트**로 세는 이유가 그것이다.
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      hits.push({ file: f, line: i + 1, text: t.slice(0, 90) });
    });
  }
  const defs = hits.filter(h => /export\s+async\s+function\s+mediaPublish/.test(h.text));
  const calls = hits.filter(h => !defs.includes(h));
  eq('mediaPublish 정의는 정확히 1개(meta.mjs)', defs.length, 1);
  eq('   그 정의는 meta.mjs 에 있다', defs[0]?.file, 'meta.mjs');
  eq('🔴 코드상 호출 지점은 정확히 1개', calls.length, 1);
  eq('   그 호출은 publish.mjs 에 있다', calls[0]?.file, 'publish.mjs');
  ok('   그 호출은 issuePublish 안이다(가드 토큰을 함께 넘긴다)',
    String(calls[0]?.text).includes('ctx.meta.mediaPublish'), JSON.stringify(calls[0]));

  // 계산된 디스패치는 정적 검사를 무력화한다 — 쓰지 않았음을 확인(약한 트립와이어지만 싸다).
  const dyn = [];
  for (const f of files) {
    const src = readFileSync(join(CARDNEWS_DIR, f), 'utf8');
    if (/meta\s*\[\s*['"`]/.test(src) || /\[\s*['"]media['"]\s*\+/.test(src)) dyn.push(f);
  }
  eq('계산된 디스패치(meta["media"+"Publish"]) 없음', dyn.length, 0);

  // 스파이크는 무인 경로에서 참조되지 않는다(§7.1 신규테스트 ④).
  const unattended = ['slot.mjs', 'run-cardnews.mjs', 'publish.mjs'];
  const spikeRefs = unattended.filter((f) => {
    const p = join(CARDNEWS_DIR, f);
    return existsSync(p) && /spike/.test(readFileSync(p, 'utf8'));
  });
  eq('무인 경로 3파일에 spike 참조 0건', spikeRefs.length, 0);
  ok('   (아직 없는 파일은 건너뛴다 — Step 6 이 만든다)',
    unattended.filter(f => existsSync(join(CARDNEWS_DIR, f))).includes('publish.mjs'));

  // publish.enabled 를 코드가 몰래 켜지 않는가 — 설정 파일만 그 권한을 갖는다.
  // ⚠ 주석·문자열을 먼저 걷어낸다. 사유 문구("publish.enabled=false (무인 발행 차단)")가
  //   대입으로 오탐되면 이 가드는 늑대소년이 되어 무시당한다.
  const stripped = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')
    .replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, "''");
  const flips = files.filter(f => /publish\s*\.\s*enabled\s*=[^=]/.test(stripped(readFileSync(join(CARDNEWS_DIR, f), 'utf8'))));
  eq('코드가 publish.enabled 를 대입하는 곳 0건(설정 파일만 그 권한)', flips.length, 0, flips.join(','));
}

// ═══ 실 설정 파일이 여전히 차단 상태인가 ═════════════════════════════════════
console.log('\n[5] 리포지토리의 실제 config/cardnews.json');
{
  const real = join(CARDNEWS_DIR, '../../config/cardnews.json');
  if (existsSync(real)) {
    const cfg = JSON.parse(readFileSync(real, 'utf8'));
    eq('🔴 publish.enabled 는 false 다(Step 6 에서만 켠다)', cfg.publish?.enabled, false);
  } else {
    ok('config/cardnews.json 부재 — Step 1 이 만든다(여기서 만들지 않는다)', true);
  }
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\ncardnews chokepoint(Step 4b): ${passN} pass / ${failN} fail`);
process.exit(failN === 0 ? 0 : 1);
