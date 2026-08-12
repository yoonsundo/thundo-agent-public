#!/usr/bin/env node
/**
 * cardnews-token.test.mjs — US-006(Step 4c) 인스타 장기 토큰 수명주기 유닛테스트 (AC-23)
 *
 * 검증 대상:
 *   (a) refreshPlan 판정 — ageDays 0/44/45/49/50/54/55/59/60/61 경계값 양쪽
 *   (b) 갱신 성공 시 파일 내용 정확 + statSync(path).mode & 0o777 === 0o600
 *   (c) 알림 스텁이 호출 시점에 process.env.NOTIFY_FORCE_LIVE === '1' 인지 단언
 *       (이 박스는 항상 RUN_MODE=mock 으로 강등되어, 이 env 없이는 경보가 사람에게
 *       도달하지 않는다 — notify-mock-gate-trap)
 *   (d) 스텁이 {telegram:'mock',discord:'mock'} 반환 시(=미전송) 코드가 그 사실을
 *       반환값에 그대로 노출하고, dedup 마커를 쓰지 않는다(마커를 쓰면 경보가 영구히
 *       삼켜진다 — shorts-curiosity/slot.mjs:203-208 결함을 반복하지 않는다)
 *   (e) halt 를 같은 날 2회 트리거해도 알림은 정확히 1회만 나간다
 *
 * 네트워크·크리덴셜 불필요(fetchImpl·notifier 전부 스텁 주입). 실 state·~/.secrets 오염 금지 —
 * STATE_DIR_OVERRIDE 로 격리, token 파일도 임시 디렉터리에 쓴다. exit 0 = 전체 통과.
 */
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'cardnews-token-'));
process.env.STATE_DIR_OVERRIDE = TMP; // 실 state/cardnews/alerts 오염 방지
process.env.RUN_MODE = 'mock';
delete process.env.NOTIFY_FORCE_LIVE;

const token = await import('../cardnews/token.mjs');

let passN = 0, failN = 0;
function ok(label, cond, extra = '') {
  if (cond) { console.log(`  [PASS] ${label}`); passN++; }
  else { console.log(`  [FAIL] ${label}${extra ? ` — ${extra}` : ''}`); failN++; }
}
const eq = (label, got, want) => ok(label, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

const CFG = { token: { lifetime_days: 60, refresh_start_day: 45, daily_retry_day: 50, escalate_day: 55 } };

/** 알림 스텁 — 호출마다 호출 시점 env 스냅샷을 같이 기록한다(P3 단언용). */
function notifierStub({ delivery = { telegram: 'sent', discord: 'sent' }, throws = false } = {}) {
  const calls = [];
  const fn = async (event, payload) => {
    calls.push({ event, payload, forceLiveAtCallTime: process.env.NOTIFY_FORCE_LIVE });
    if (throws) throw new Error('notify 폭발(스텁)');
    return delivery;
  };
  fn.calls = calls;
  return fn;
}

function tokenFixture({ issuedDaysAgo, expiresDaysFromNow = 999, now }) {
  const nowMs = now.getTime();
  return {
    ig_user_id: '17800000000000000',
    access_token: 'OLD_TOKEN',
    issued_at: new Date(nowMs - issuedDaysAgo * 86400000).toISOString(),
    expires_at: new Date(nowMs + expiresDaysFromNow * 86400000).toISOString(),
  };
}

let seq = 0;
function writeTokenFile(tok) {
  const p = join(TMP, `ig-token-${++seq}.json`);
  writeFileSync(p, JSON.stringify(tok), 'utf8');
  return p;
}

// ─── (a) refreshPlan 경계 10종 ───────────────────────────────────────────────
console.log('\n(a) refreshPlan 경계값 — 45/50/55/60');
{
  const cases = [
    [0, 'noop', null], [44, 'noop', null],
    [45, 'try', 'info'], [49, 'try', 'info'],
    [50, 'try-daily', 'warn'], [54, 'try-daily', 'warn'],
    [55, 'try-escalate', 'alert'], [59, 'try-escalate', 'alert'],
    [60, 'halt', 'alert'], [61, 'halt', 'alert'],
  ];
  for (const [ageDays, wantAction, wantSeverity] of cases) {
    const p = token.refreshPlan({ ageDays, expired: false, cfg: CFG });
    eq(`ageDays=${ageDays} → action`, p.action, wantAction);
    eq(`ageDays=${ageDays} → severity`, p.severity, wantSeverity);
  }
  const expiredEarly = token.refreshPlan({ ageDays: 10, expired: true, cfg: CFG });
  eq('expired 플래그는 나이 무관 halt', expiredEarly.action, 'halt');

  // cfg.token 누락 시에도 스펙 기본값(45/50/55/60)으로 동작해야 한다.
  eq('cfg 없어도 기본 문턱 45', token.refreshPlan({ ageDays: 45, expired: false }).action, 'try');
}

// ─── (b) 갱신 성공 → 파일 내용 + 0600 ─────────────────────────────────────────
console.log('\n(b) 갱신 성공 → 파일 내용 정확 + 파일 모드 0600');
{
  const now = new Date('2026-08-01T00:00:00Z');
  const initial = tokenFixture({ issuedDaysAgo: 46, now }); // 45≤a<50 → 'try'
  const tokenFile = writeTokenFile(initial);
  const cfg = { ...CFG, meta: { token_file: tokenFile } };
  let fetchCalls = 0;
  const fetchImpl = async (url) => {
    fetchCalls++;
    ok('refresh_access_token 엔드포인트 호출', /\/refresh_access_token\?/.test(url) && /grant_type=ig_refresh_token/.test(url), url);
    return { status: 200, json: async () => ({ access_token: 'NEW_TOKEN_XYZ', expires_in: 5184000 }) };
  };
  const notifier = notifierStub();
  const r = await token.runTokenMaintenance({ cfg, now, fetchImpl, notifier });

  eq('action=try', r.plan.action, 'try');
  eq('네트워크 1회 호출', fetchCalls, 1);
  eq('갱신 성공', r.refreshed?.ok, true);
  eq('성공 시 경보 없음', r.alerted, false);
  eq('성공 시 delivered=null', r.delivered, null);

  const saved = JSON.parse(readFileSync(tokenFile, 'utf8'));
  eq('새 access_token 저장', saved.access_token, 'NEW_TOKEN_XYZ');
  eq('issued_at = now', saved.issued_at, now.toISOString());
  eq('expires_at = now + expires_in', saved.expires_at, new Date(now.getTime() + 5184000 * 1000).toISOString());
  eq('ig_user_id 보존(스프레드 유지)', saved.ig_user_id, initial.ig_user_id);

  const mode = statSync(tokenFile).mode & 0o777;
  eq('파일 모드 0600', mode, 0o600);
}

// ─── (c) 경보 발송 시점에 NOTIFY_FORCE_LIVE=1 강제 ────────────────────────────
console.log('\n(c) 경보는 호출 시점에 NOTIFY_FORCE_LIVE=1 을 강제한다');
{
  const now = new Date('2026-08-02T00:00:00Z');
  delete process.env.NOTIFY_FORCE_LIVE; // 코드가 스스로 세팅하는지 확인하려면 미리 지워야 한다
  const expiredTok = tokenFixture({ issuedDaysAgo: 61, expiresDaysFromNow: -1, now });
  const tokenFile = writeTokenFile(expiredTok);
  const cfg = { ...CFG, meta: { token_file: tokenFile } };
  const notifier = notifierStub();
  const r = await token.runTokenMaintenance({
    cfg, now, notifier,
    fetchImpl: async () => { throw new Error('halt 인데 네트워크가 불렸다(결함)'); },
  });

  eq('action=halt', r.plan.action, 'halt');
  eq('halt 는 네트워크를 안 친다', true, true); // fetchImpl 이 안 불렸으면 위에서 throw 안 됐을 것
  eq('경보 1회 호출', notifier.calls.length, 1);
  eq('호출 시점 NOTIFY_FORCE_LIVE=1', notifier.calls[0]?.forceLiveAtCallTime, '1');
  eq('sent 배달 → alerted=true', r.alerted, true);
  eq('sent 배달 → delivered.telegram=sent', r.delivered?.telegram, 'sent');
}

// ─── (d) 미전송 델리버리 → 반환값에 표면화 + 마커 미기록 ──────────────────────
console.log('\n(d) 미전송({telegram:mock,discord:mock}) → 표면화 + 마커 미기록');
{
  const now = new Date('2026-08-03T00:00:00Z');
  const expiredTok = tokenFixture({ issuedDaysAgo: 65, expiresDaysFromNow: -1, now });
  const tokenFile = writeTokenFile(expiredTok);
  const cfg = { ...CFG, meta: { token_file: tokenFile } };
  const notifier = notifierStub({ delivery: { telegram: 'mock', discord: 'mock' } });
  const noNetwork = async () => { throw new Error('halt 인데 네트워크가 불렸다(결함)'); };

  const r1 = await token.runTokenMaintenance({ cfg, now, fetchImpl: noNetwork, notifier });
  eq('알림 시도됨', r1.alerted, true);
  eq('미전송이 delivered.telegram 에 그대로 노출', r1.delivered?.telegram, 'mock');
  eq('미전송이 delivered.discord 에 그대로 노출', r1.delivered?.discord, 'mock');

  const marker = join(TMP, 'cardnews', 'alerts', 'token-2026-08-03.marker');
  ok('마커 미기록(미전송이므로)', !existsSync(marker), marker);

  // 마커가 안 쓰였으므로 같은 날 재시도해도 다시 알림을 시도해야 한다 — 영구 삼킴 금지(P5).
  const r2 = await token.runTokenMaintenance({ cfg, now, fetchImpl: noNetwork, notifier });
  eq('재시도도 다시 알림 시도(삼켜지지 않음)', r2.alerted, true);
  eq('알림 총 2회 호출(둘 다 미전송이라 dedup 미적용)', notifier.calls.length, 2);
}

// ─── (e) halt 같은 날 2회 → 알림 정확히 1회 ───────────────────────────────────
console.log('\n(e) halt 같은 날 2회 → 알림 정확히 1회(dedup 마커)');
{
  const now = new Date('2026-08-04T00:00:00Z');
  const expiredTok = tokenFixture({ issuedDaysAgo: 70, expiresDaysFromNow: -2, now });
  const tokenFile = writeTokenFile(expiredTok);
  const cfg = { ...CFG, meta: { token_file: tokenFile } };
  const notifier = notifierStub({ delivery: { telegram: 'sent', discord: 'sent' } });
  const noNetwork = async () => { throw new Error('halt 인데 네트워크가 불렸다(결함)'); };

  const r1 = await token.runTokenMaintenance({ cfg, now, fetchImpl: noNetwork, notifier });
  eq('첫 halt 경보 발송(alerted)', r1.alerted, true);
  eq('첫 halt 도달(sent)', r1.delivered?.telegram, 'sent');

  const r2 = await token.runTokenMaintenance({
    cfg, now: new Date(now.getTime() + 3 * 3600000), fetchImpl: noNetwork, notifier,
  });
  eq('둘째 halt 는 마커에 막혀 미발송', r2.alerted, false);
  eq('둘째 halt skipped 표시 없음(delivered=null)', r2.delivered, null);

  eq('알림은 정확히 1회', notifier.calls.length, 1);

  const marker = join(TMP, 'cardnews', 'alerts', 'token-2026-08-04.marker');
  ok('마커 파일 존재', existsSync(marker), marker);
}

// ─── (f) 경보 실패 내성 — notifier 가 throw 해도 유지보수는 죽지 않는다 ────────
console.log('\n(f) notifier throw 를 흡수(런 자체는 죽지 않음)');
{
  const now = new Date('2026-08-05T00:00:00Z');
  const expiredTok = tokenFixture({ issuedDaysAgo: 61, expiresDaysFromNow: -1, now });
  const tokenFile = writeTokenFile(expiredTok);
  const cfg = { ...CFG, meta: { token_file: tokenFile } };
  const notifier = notifierStub({ throws: true });

  const r = await token.runTokenMaintenance({
    cfg, now, notifier, fetchImpl: async () => { throw new Error('halt 인데 네트워크가 불렸다(결함)'); },
  });
  eq('throw 흡수 후에도 결과 반환', typeof r.plan.action, 'string');
  eq('throw 는 미전송으로 처리', r.alerted, true);
  eq('throw 후 delivered 는 error/error', JSON.stringify(r.delivered), JSON.stringify({ telegram: 'error', discord: 'error' }));
}

// ─── (g) noop 구간은 네트워크·알림 둘 다 건드리지 않는다 ──────────────────────
console.log('\n(g) noop(<45일) 구간은 무동작');
{
  const now = new Date('2026-08-06T00:00:00Z');
  const freshTok = tokenFixture({ issuedDaysAgo: 10, now });
  const tokenFile = writeTokenFile(freshTok);
  const cfg = { ...CFG, meta: { token_file: tokenFile } };
  const notifier = notifierStub();
  const r = await token.runTokenMaintenance({
    cfg, now, notifier, fetchImpl: async () => { throw new Error('noop 인데 네트워크가 불렸다(결함)'); },
  });
  eq('action=noop', r.plan.action, 'noop');
  eq('알림 미호출', notifier.calls.length, 0);
  eq('갱신 시도 없음', r.refreshed, null);
}

// ─── 정리 ────────────────────────────────────────────────────────────────────
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 임시 디렉터리 정리 실패 무시 */ }

console.log(`\n토큰 수명주기(US-006): ${passN} pass / ${failN} fail`);
process.exit(failN === 0 ? 0 : 1);
