/**
 * cardnews/token.mjs — Instagram 장기 토큰 수명주기 (계획 §3.15, AC-23)
 *
 * IG 장기 토큰은 60일이면 만료된다. 그리고 이 채널은 무인 cron 이라, 만료를 조용히 맞으면
 * 발행이 원인 불명으로 멈춘 채 아무도 모른다(§6.1 R8). 그래서 갱신은 "실패해도 계속 재시도"가
 * 아니라 **에스컬레이션 사다리**다 — 급하지 않을 때(45일~)는 하루 1회만 조용히 시도하고,
 * 급해질수록(50일→55일) 시도 빈도와 경보 강도를 올리고, 만료되면 발행을 멈추고 pending 을
 * 보존한 채 사람을 부른다.
 *
 * ⚠ 이 박스는 크리덴셜 부재로 config 가 항상 mock 으로 강등돼 알림이 조용히 로그 파일로만
 * 간다(`notify-mock-gate-trap`). 운영 경보는 `NOTIFY_FORCE_LIVE='1'` 없이는 사람에게 도달하지
 * 않으므로, 호출 직전에 강제로 세팅한다. 그리고 `notify()` 의 반환값은 `'sent'` 와 그 외
 * (mock·console-fallback 등)를 **의도적으로 구분**한다(`notify/index.mjs:58-63`) — 이걸
 * boolean `ok` 로 뭉개면 "아무데도 안 갔는데 성공"이 된다. 그래서 여기서도 `sent===true` 일
 * 때만 dedup 마커를 쓴다. 원본 `shorts-curiosity/slot.mjs:203-208` 은 실패해도 마커를 무조건
 * 써서 다음 슬롯이 재시도를 못 하게 막는 결함이 있다 — 그 결함을 여기서 반복하지 않는다.
 */
import {
  existsSync, mkdirSync, writeFileSync, renameSync, chmodSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { alertsDir, isMainModule, loadConfig } from './lib.mjs';
import { loadToken } from './meta.mjs';
import { notify } from '../notify/index.mjs';
import { makeLogger } from '../lib/log.mjs';

const log = makeLogger('cardnews-token');

const DEFAULT_GRAPH_BASE = 'https://graph.instagram.com';

// EVENTS 상수는 아직 notify/index.mjs 에 없다(추가는 Step 6, Tier B — 이 단계는 out of scope).
// notify()는 event 를 단순 라벨로만 쓰므로(EVENTS 멤버십을 검사하지 않는다) 문자열을 직접
// 써도 동작은 완전하고, Step 6에서 같은 문자열 값으로 EVENTS 에 정식 편입되면 그대로 맞는다.
const EVENT_TOKEN_EXPIRED = 'CARDNEWS_TOKEN_EXPIRED';
const EVENT_TOKEN_REFRESH_ISSUE = 'CARDNEWS_TOKEN_REFRESH_ISSUE';

// ── 순수 판정 ────────────────────────────────────────────────────────────────

/** 토큰 나이(일)·만료 여부. `now` 주입 가능(테스트용). */
export function tokenAge(token, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const issuedMs = Date.parse(token?.issued_at ?? '');
  const expiresMs = Date.parse(token?.expires_at ?? '');
  const ageDays = Number.isFinite(issuedMs)
    ? Math.floor((nowMs - issuedMs) / 86400000)
    : Infinity; // issued_at 파싱 불가 → 가장 위험한 쪽(halt)으로 fail-closed
  const expired = Number.isFinite(expiresMs) ? nowMs >= expiresMs : true;
  return { ageDays, expired };
}

/**
 * 45/50/55/60 에스컬레이션 사다리. 순수 함수 — `now` 는 호출자가 `tokenAge` 로 이미 주입했다.
 * 문턱값은 `cfg.token`(§3.1) 우선, 없으면 스펙 기본값(45/50/55/60).
 */
export function refreshPlan({ ageDays, expired, cfg } = {}) {
  const t = cfg?.token || {};
  const lifetimeDays = t.lifetime_days ?? 60;
  const refreshStartDay = t.refresh_start_day ?? 45;
  const dailyRetryDay = t.daily_retry_day ?? 50;
  const escalateDay = t.escalate_day ?? 55;

  if (expired || ageDays >= lifetimeDays) {
    return { action: 'halt', severity: 'alert' };
  }
  if (ageDays >= escalateDay) {
    return { action: 'try-escalate', severity: 'alert' };
  }
  if (ageDays >= dailyRetryDay) {
    return { action: 'try-daily', severity: 'warn' };
  }
  if (ageDays >= refreshStartDay) {
    return { action: 'try', severity: 'info' };
  }
  return { action: 'noop', severity: null };
}

// ── 네트워크 ─────────────────────────────────────────────────────────────────

/** 응답 본문을 JSON 으로 최대한 읽되 실패해도 throw 하지 않는다(meta.mjs 관례 동일). */
async function readBody(res) {
  try { return await res.json(); } catch { /* JSON 아님 */ }
  try { return { raw: (await res.text()).slice(0, 300) }; } catch { return {}; }
}

/**
 * `GET {graph}/refresh_access_token?grant_type=ig_refresh_token&access_token=…`
 * Meta 정책: 발급 후 24h 미만이거나 이미 만료된 토큰은 갱신 자격이 없다 — 네트워크를
 * 치기 전에 fail-closed 로 걸러 헛콜을 막는다.
 */
export async function refreshToken(token, { fetchImpl = fetch, cfg, now = new Date() } = {}) {
  const { ageDays, expired } = tokenAge(token, now);
  if (expired) return { ok: false, reason: '토큰 이미 만료 — 갱신 불가(재인증 필요)' };
  if (!(ageDays >= 1)) return { ok: false, reason: '발급 24시간 미만 — 갱신 자격 없음(Meta 정책)' };

  const graphBase = token?.graph_base || cfg?.meta?.graph_base || DEFAULT_GRAPH_BASE;
  const url = `${graphBase}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token?.access_token || '')}`;

  let res, body;
  try {
    res = await fetchImpl(url);
    body = await readBody(res);
  } catch (e) {
    return { ok: false, reason: `네트워크: ${e.message}` };
  }
  if (res.status >= 300) {
    return { ok: false, status: res.status, reason: `HTTP ${res.status}` };
  }
  const accessToken = body?.access_token;
  const expiresIn = Number(body?.expires_in);
  if (!accessToken || !Number.isFinite(expiresIn)) {
    return { ok: false, status: res.status, reason: '응답에 access_token/expires_in 없음' };
  }

  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const refreshed = {
    ...token,
    access_token: accessToken,
    issued_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + expiresIn * 1000).toISOString(),
  };
  return { ok: true, token: refreshed };
}

// ── 영속화 ───────────────────────────────────────────────────────────────────

/**
 * 원자적 write(임시파일 → rename) + 파일 모드 0600 강제.
 * `writeFileSync` 의 `mode` 옵션은 프로세스 umask 의 영향을 받을 수 있어, rename 뒤
 * `chmodSync` 로 다시 못박는다 — 크리덴셜 파일이 그룹/전체에 읽히면 안 된다.
 */
export function persistToken(token, path) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  return { ok: true, path };
}

// ── 경보 ─────────────────────────────────────────────────────────────────────

function dateKey(now) {
  const d = now instanceof Date ? now : new Date(now);
  return d.toISOString().slice(0, 10);
}

/** §3.15: `state/cardnews/alerts/token-{YYYY-MM-DD}.marker` — 하루 1회 경보 dedup. */
function alertMarkerPath(now) {
  return join(alertsDir(), `token-${dateKey(now)}.marker`);
}

/** 저강도(`try`) 구간의 "시도 자체를 하루 1회로" dedup — 경보 마커와는 별개. */
function attemptMarkerPath(now) {
  return join(alertsDir(), `token-attempt-${dateKey(now)}.marker`);
}

function writeMarker(path, body) {
  try {
    mkdirSync(alertsDir(), { recursive: true });
    writeFileSync(path, body, 'utf8');
  } catch (e) {
    log.warn(`마커 기록 실패(다음 런에서 재시도될 수 있음): ${e.message}`);
  }
}

/**
 * 하루 1회 경보 발송. `sent===true` 일 때만 마커를 쓴다(P5) — 미전송인데 마커를 쓰면
 * 다음 날까지(또는 영구히) 경보가 삼켜진다.
 */
async function sendAlertOnce({ now, notifier, event, payload }) {
  const marker = alertMarkerPath(now);
  try {
    if (existsSync(marker)) {
      return { alerted: false, sent: false, skipped: 'marker', marker, delivery: null };
    }
  } catch (e) {
    log.warn(`경보 마커 확인 실패(경보는 계속): ${e.message}`);
  }

  process.env.NOTIFY_FORCE_LIVE = '1'; // forceLive() 는 호출 시점 env 를 읽는다
  let delivery;
  try {
    delivery = await notifier(event, payload);
  } catch (e) {
    log.error(`토큰 경보 발송 자체 실패: ${e?.message || e}`);
    delivery = { telegram: 'error', discord: 'error' };
  }

  const sent = !!delivery && (delivery.telegram === 'sent' || delivery.discord === 'sent');
  if (sent) {
    writeMarker(marker, `${new Date().toISOString()} ${event}\n`);
  } else {
    log.warn(`토큰 경보가 사람에게 도달하지 않았다(크리덴셜 확인) — ${JSON.stringify(delivery)}`);
  }

  return { alerted: true, sent, delivery, marker: sent ? marker : null };
}

// ── 오케스트레이션 ───────────────────────────────────────────────────────────

/**
 * 토큰 유지보수 1회 실행 — `runDaily` 가 sweep 보다 먼저 부른다(만료 토큰으로 Meta 를
 * 쏘지 않기 위해, §3.16 step 0a).
 *
 * @returns {Promise<{plan:{action:string,severity:string|null}, refreshed:object|null,
 *                     alerted:boolean, delivered:object|null, reason?:string}>}
 */
export async function runTokenMaintenance({
  cfg, now = new Date(), fetchImpl = fetch, notifier = notify,
} = {}) {
  const loaded = loadToken(cfg);
  if (!loaded.ok) {
    log.warn(`토큰 로드 실패 — 유지보수 생략: ${loaded.reason}`);
    return {
      plan: { action: 'noop', severity: null }, refreshed: null, alerted: false, delivered: null,
      reason: loaded.reason,
    };
  }
  const { token, tokenFile } = loaded;
  const { ageDays, expired } = tokenAge(token, now);
  const plan = refreshPlan({ ageDays, expired, cfg });

  let refreshed = null;
  let alerted = false;
  let delivered = null;

  if (plan.action === 'noop') {
    return { plan, refreshed, alerted, delivered };
  }

  if (plan.action === 'halt') {
    const alert = await sendAlertOnce({
      now, notifier, event: EVENT_TOKEN_EXPIRED,
      payload: {
        reason: `IG 장기 토큰 만료(나이 ${Number.isFinite(ageDays) ? ageDays : '?'}일) — 발행 중단, pending 보존`,
        details: `재인증 필요: npm run cardnews:token-login 또는 instagram-oauth.json 재발급. token_file=${tokenFile}`,
      },
    });
    alerted = alert.alerted;
    delivered = alert.delivery;
    return { plan, refreshed, alerted, delivered };
  }

  // 'try' 구간(45~49일)은 저강도라 시도 자체를 하루 1회로 제한한다.
  if (plan.action === 'try') {
    const attemptMarker = attemptMarkerPath(now);
    if (existsSync(attemptMarker)) {
      return { plan, refreshed: { skipped: 'already-attempted-today' }, alerted, delivered };
    }
  }

  refreshed = await refreshToken(token, { fetchImpl, cfg, now });

  if (plan.action === 'try') {
    writeMarker(attemptMarkerPath(now), `${new Date().toISOString()} attempted\n`);
  }

  if (refreshed.ok) {
    persistToken(refreshed.token, tokenFile);
    log.info(`토큰 갱신 성공(${plan.action}) — 새 만료: ${refreshed.token.expires_at}`);
    return { plan, refreshed, alerted, delivered };
  }

  // 갱신 실패 → 강도별 severity 로 경보(마커는 sendAlertOnce 내부에서 sent 일 때만).
  const alert = await sendAlertOnce({
    now, notifier, event: EVENT_TOKEN_REFRESH_ISSUE,
    payload: {
      reason: `IG 장기 토큰 갱신 실패(${plan.action}, severity=${plan.severity}, 나이 ${ageDays}일): ${refreshed.reason}`,
      details: `token_file=${tokenFile}`,
    },
  });
  alerted = alert.alerted;
  delivered = alert.delivery;
  return { plan, refreshed, alerted, delivered };
}

// ── CLI (token-cron.sh 진입점) ───────────────────────────────────────────────

if (isMainModule(import.meta.url)) {
  const cfg = loadConfig();
  runTokenMaintenance({ cfg }).then((r) => {
    console.log(JSON.stringify(r));
    process.exit(0); // halt 는 정상적으로 처리된 상태다 — 실패는 예외(2)로만 신호한다
  }).catch((e) => {
    log.error(`토큰 유지보수 예외: ${e?.message || e}`);
    console.log(JSON.stringify({ ok: false, error: String(e?.message || e) }));
    process.exit(2);
  });
}
