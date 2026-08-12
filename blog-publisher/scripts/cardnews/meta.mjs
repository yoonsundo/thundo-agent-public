/**
 * cardnews/meta.mjs — Instagram Graph API 클라이언트 + 🔴 발행 초크포인트 (계획 §3.13)
 *
 * 인스타그램 발행은 되돌릴 수 없다(잘못 나간 게시물은 우리 코드로 지울 수 없다). 그래서 이
 * 모듈의 함수는 **하나도 throw 하지 않고** 전부 `{ok, …}` 를 돌려주며(상위가 상태를 보존한
 * 채 held 로 내려가야 한다), 실제 발행은 **가드 토큰 없이는 실행 자체가 불가능**하다.
 *
 * 가드가 필요한 이유는 방어적 취향이 아니라 실측이다: 발행 차단 스위치가 계획 개정 3회
 * 연속으로 "그 검사를 잊은 새 코드 경로"에 의해 우회됐다. 정적 grep 은 계산된 디스패치·
 * 다른 이름의 두 번째 발행 함수·주입된 스텁에 무력하다. 그래서 검사를 런타임으로 올렸다 —
 * 잊는 것이 **탐지되는** 게 아니라 **불가능**해진다. 편의용 우회구를 추가하지 말 것.
 *
 * 모든 네트워크 호출은 `fetchImpl` 주입을 받는다(크리덴셜·네트워크 없이 단위테스트 가능).
 */
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expandHome, sha256, normalizeCaption } from './lib.mjs';

// 설정이 언제나 우선. 토큰·옵션 어디에도 없을 때만 쓰는 최후 폴백.
const DEFAULT_GRAPH_BASE = 'https://graph.instagram.com';
const DEFAULT_API_VERSION = 'v25.0';

const TOKEN_KEYS = ['ig_user_id', 'access_token', 'issued_at', 'expires_at'];

/**
 * 🔴 발행 가드 원장 — **export 하지 않는다.**
 * `guardPublish` 만 여기에 넣을 수 있고, 발행 시 소비되며(1회용), 모듈 밖에서는 관측도
 * 조작도 불가능하다. 이 Set 을 노출하는 순간 위 4중 강제가 통째로 무의미해진다.
 */
const _activeGuards = new Set();

// ── 엔드포인트 ───────────────────────────────────────────────────────────────

function endpoint(t, path, opt = {}) {
  const base = opt.cfg?.meta?.graph_base || t?.graph_base || DEFAULT_GRAPH_BASE;
  const ver = opt.cfg?.meta?.api_version || t?.api_version || DEFAULT_API_VERSION;
  return `${base}/${ver}${path}`;
}

function authHeaders(t) {
  return { Authorization: `Bearer ${t?.access_token || ''}` };
}

/** 응답 본문을 JSON 으로 최대한 읽되, 실패해도 throw 하지 않는다. */
async function readBody(res) {
  try { return await res.json(); } catch { /* JSON 아님 */ }
  try { return { raw: (await res.text()).slice(0, 300) }; } catch { return {}; }
}

// ── 토큰 ─────────────────────────────────────────────────────────────────────

/**
 * `~/.secrets/instagram-oauth.json` 로드(경로는 config `meta.token_file`).
 * 크리덴셜을 env 가 아니라 파일로 두는 것은 유튜브 OAuth·GSC 서비스계정과 같은 전례다.
 * 엔드포인트 정보를 토큰에 새겨 두어, 토큰만 받는 하위 함수들이 설정 없이도 동작한다.
 */
export function loadToken(cfg) {
  const p = expandHome(cfg?.meta?.token_file || '');
  if (!p) return { ok: false, reason: 'meta.token_file 미설정' };
  if (!existsSync(p)) return { ok: false, reason: `토큰 파일 없음: ${p}` };
  let tok;
  try { tok = JSON.parse(readFileSync(p, 'utf8')); } catch { return { ok: false, reason: '토큰 파일 파싱 실패' }; }
  for (const k of TOKEN_KEYS) {
    if (!tok[k]) return { ok: false, reason: `토큰에 ${k} 없음` };
  }
  return {
    ok: true,
    tokenFile: p,
    token: {
      ...tok,
      graph_base: cfg?.meta?.graph_base || DEFAULT_GRAPH_BASE,
      api_version: cfg?.meta?.api_version || DEFAULT_API_VERSION,
    },
  };
}

/**
 * 발행 가능 여부 사전 점검(파괴적 동작 없음) — `shorts/upload.mjs` 의 uploadReadiness 미러.
 * `publish.enabled=false` 가 무인 발행 마스터 스위치이며 Step 6 에서만 켠다.
 */
export function publishReadiness(cfg, token) {
  if (!cfg?.publish?.enabled) return { ready: false, reason: 'publish.enabled=false (무인 발행 차단)' };
  if (token) {
    for (const k of TOKEN_KEYS) {
      if (!token[k]) return { ready: false, reason: `토큰에 ${k} 없음` };
    }
    return { ready: true, token };
  }
  const r = loadToken(cfg);
  if (!r.ok) return { ready: false, reason: r.reason };
  return { ready: true, token: r.token, tokenFile: r.tokenFile };
}

// ── 발행 한도 (fail-closed) ──────────────────────────────────────────────────

/**
 * 24시간 발행 한도 조회. `quota_total` 은 응답의 `config` 안에 **중첩**돼 있다.
 *
 * 🔴 fail-closed: 한도를 못 읽으면 `{ok:false}` 로 발행을 막는다. 못 읽었는데 통과시키면
 * 한도 초과 발행이 조용히 실패하며 그날 채널이 죽는다. 상한 숫자는 절대 하드코딩하지 않는다
 * (Meta 가 계정 등급별로 바꾼다).
 */
export async function publishingLimit(t, { fetchImpl = fetch, cfg } = {}) {
  const url = endpoint(t, `/${t?.ig_user_id}/content_publishing_limit?fields=config,quota_usage`, { cfg });
  let res, body;
  try {
    res = await fetchImpl(url, { headers: authHeaders(t) });
    body = await readBody(res);
  } catch (e) {
    return { ok: false, reason: `네트워크: ${e.message}` };
  }
  if (res.status >= 300) {
    return { ok: false, status: res.status, reason: `HTTP ${res.status}`, error: classifyMetaError(res.status, body) };
  }
  const item = Array.isArray(body?.data) ? body.data[0] : body;
  const quotaTotal = Number(item?.config?.quota_total);
  const quotaUsage = Number(item?.quota_usage);
  if (!Number.isFinite(quotaTotal)) return { ok: false, reason: 'quota_total 파싱 실패(fail-closed)' };
  if (!Number.isFinite(quotaUsage)) return { ok: false, reason: 'quota_usage 파싱 실패(fail-closed)' };
  return { ok: true, quotaUsage, quotaTotal, allowed: quotaUsage < quotaTotal };
}

// ── 🔴 초크포인트 ────────────────────────────────────────────────────────────

/**
 * 발행 가드 발급 — readiness(마스터 스위치+토큰) → 한도, **둘 다 통과할 때만** 토큰을 찍는다.
 * 발급된 id 는 1회용이라 재사용·replay 가 불가능하다.
 * @returns {Promise<{ok:true, token, limit, guardToken:{id:string, issuedAt:number}}
 *                  |{ok:false, gate:'readiness'|'limit', reason:string}>}
 */
export async function guardPublish(cfg, token, { fetchImpl = fetch } = {}) {
  const r = publishReadiness(cfg, token);
  if (!r.ready) return { ok: false, gate: 'readiness', reason: r.reason };
  const lim = await publishingLimit(r.token, { fetchImpl, cfg });
  if (!lim.ok) return { ok: false, gate: 'limit', reason: lim.reason || 'quota_total 파싱 실패(fail-closed)' };
  if (!lim.allowed) return { ok: false, gate: 'limit', reason: `quota ${lim.quotaUsage}/${lim.quotaTotal}` };
  const guardToken = { id: randomUUID(), issuedAt: Date.now() };
  _activeGuards.add(guardToken.id);
  return { ok: true, token: r.token, limit: lim, guardToken };
}

/**
 * 캐러셀 컨테이너를 실제 게시물로 만든다 — **유일한 발행 지점**.
 *
 * 🔴 유효한 가드 토큰이 없으면 네트워크를 건드리기 **전에** 거부한다. 새로 생기는 어떤
 * 코드 경로도 이 검사를 우회할 수 없다(가드는 이 모듈 밖에서 만들 수 없다).
 *
 * @returns {Promise<{ok:true, mediaId:string}
 *                  |{ok:false, outcome:'rejected'|'unknown', status?:number, reason:string}>}
 *          `unknown` = 타임아웃·5xx·네트워크 오류. 발행됐는지 **모르는** 상태이므로 상위는
 *          재시도하지 말고 reconcile 로 확인해야 한다.
 */
export async function mediaPublish(t, { creationId, guardToken }, { fetchImpl = fetch, cfg, timeoutMs } = {}) {
  if (!guardToken || !_activeGuards.has(guardToken.id)) {
    return { ok: false, outcome: 'rejected', reason: 'no-guard' };
  }
  _activeGuards.delete(guardToken.id); // 1회용 — replay 방지
  if (!creationId) return { ok: false, outcome: 'rejected', reason: 'creation_id 없음' };

  const url = endpoint(t, `/${t?.ig_user_id}/media_publish?creation_id=${encodeURIComponent(creationId)}`, { cfg });
  const ms = timeoutMs || cfg?.meta?.publish_timeout_ms || 60000;
  let res, body;
  try {
    res = await fetchImpl(url, { method: 'POST', headers: authHeaders(t), signal: AbortSignal.timeout(ms) });
    body = await readBody(res);
  } catch (e) {
    return { ok: false, outcome: 'unknown', reason: `네트워크/타임아웃: ${e.message}` };
  }
  if (res.status >= 500) {
    return { ok: false, outcome: 'unknown', status: res.status, reason: `HTTP ${res.status}` };
  }
  if (res.status >= 300) {
    return { ok: false, outcome: 'rejected', status: res.status, reason: classifyMetaError(res.status, body) };
  }
  if (!body?.id) return { ok: false, outcome: 'unknown', status: res.status, reason: 'media id 부재' };
  return { ok: true, mediaId: String(body.id) };
}

// ── 컨테이너 생성 ────────────────────────────────────────────────────────────

/**
 * 캐러셀 자식 컨테이너 1개. Meta 는 생성시각을 돌려주지 않으므로 **호출 직전** 우리 시계를
 * 찍는다 — 만료를 과소가 아니라 과대추정하는 쪽이 안전하다(만료된 컨테이너로 발행하면 실패).
 */
export async function createChildContainer(t, { imageUrl }, { fetchImpl = fetch, cfg } = {}) {
  const url = endpoint(t, `/${t?.ig_user_id}/media?image_url=${encodeURIComponent(imageUrl || '')}&is_carousel_item=true`, { cfg });
  const createdAt = new Date().toISOString();
  let res, body;
  try {
    res = await fetchImpl(url, { method: 'POST', headers: authHeaders(t) });
    body = await readBody(res);
  } catch (e) {
    return { ok: false, reason: `네트워크: ${e.message}`, error: 'transient', createdAt };
  }
  if (res.status >= 300) {
    return { ok: false, status: res.status, reason: `HTTP ${res.status}`, error: classifyMetaError(res.status, body), createdAt };
  }
  if (!body?.id) return { ok: false, status: res.status, reason: 'container id 부재', error: 'unknown', createdAt };
  return { ok: true, containerId: String(body.id), createdAt };
}

/** 자식 7개를 묶는 캐러셀 컨테이너. createdAt 규칙은 자식과 동일. */
export async function createCarouselContainer(t, { childIds, caption }, { fetchImpl = fetch, cfg } = {}) {
  const children = (childIds || []).join(',');
  const url = endpoint(t, `/${t?.ig_user_id}/media?media_type=CAROUSEL&children=${encodeURIComponent(children)}&caption=${encodeURIComponent(caption || '')}`, { cfg });
  const createdAt = new Date().toISOString();
  let res, body;
  try {
    res = await fetchImpl(url, { method: 'POST', headers: authHeaders(t) });
    body = await readBody(res);
  } catch (e) {
    return { ok: false, reason: `네트워크: ${e.message}`, error: 'transient', createdAt };
  }
  if (res.status >= 300) {
    return { ok: false, status: res.status, reason: `HTTP ${res.status}`, error: classifyMetaError(res.status, body), createdAt };
  }
  if (!body?.id) return { ok: false, status: res.status, reason: 'container id 부재', error: 'unknown', createdAt };
  return { ok: true, containerId: String(body.id), createdAt, childrenKey: children };
}

// ── 조회 ─────────────────────────────────────────────────────────────────────

/** 최근 미디어 목록. limit 은 페이지네이션 파라미터(발행 한도와 무관). */
export async function recentMedia(t, { limit = 25, since } = {}, { fetchImpl = fetch, cfg } = {}) {
  let path = `/${t?.ig_user_id}/media?fields=id,caption,timestamp&limit=${encodeURIComponent(limit)}`;
  if (since) path += `&since=${encodeURIComponent(Math.floor(new Date(since).getTime() / 1000))}`;
  let res, body;
  try {
    res = await fetchImpl(endpoint(t, path, { cfg }), { headers: authHeaders(t) });
    body = await readBody(res);
  } catch (e) {
    return { ok: false, reason: `네트워크: ${e.message}`, error: 'transient' };
  }
  if (res.status >= 300) {
    return { ok: false, status: res.status, reason: `HTTP ${res.status}`, error: classifyMetaError(res.status, body) };
  }
  return { ok: true, items: Array.isArray(body?.data) ? body.data : [] };
}

/** 발행 후 실제 노출 확인용(발행 성공이 노출을 뜻하지 않는다 — withheld 가능). */
export async function getMedia(t, { mediaId }, { fetchImpl = fetch, cfg } = {}) {
  let res, body;
  try {
    res = await fetchImpl(endpoint(t, `/${encodeURIComponent(mediaId)}?fields=id,permalink,timestamp`, { cfg }), { headers: authHeaders(t) });
    body = await readBody(res);
  } catch (e) {
    return { ok: false, reason: `네트워크: ${e.message}`, error: 'transient' };
  }
  if (res.status >= 300) {
    return { ok: false, status: res.status, reason: `HTTP ${res.status}`, error: classifyMetaError(res.status, body) };
  }
  return { ok: true, mediaId: String(body?.id ?? mediaId), permalink: body?.permalink || null, timestamp: body?.timestamp || null };
}

/**
 * 발행 결과가 불확실할 때(publish_unknown) "이미 올라갔는가"를 판정한다.
 *  - M2(주): 캡션 말미의 멱등 마커 포함 여부.
 *  - M1(폴백): 정규화 캡션 앞 200자의 sha256 일치.
 *  - negative guard: 매칭은 0건인데 우리 요청 시각보다 **뒤에** 생긴 미디어가 있다면, 그게
 *    우리 것인지 아닌지 단정할 수 없다 → `ambiguous`. 이때 재발행하면 중복 게시가 된다.
 *
 * @returns {Promise<{ok:true, mediaId:string|null, ambiguous?:boolean, matchedBy?:string}
 *                  |{ok:false, reason:string}>}
 */
export async function findPublished(t, { idemMarker, captionSha, since, newerTs }, { fetchImpl = fetch, cfg } = {}) {
  const limit = cfg?.meta?.recent_media_limit || 25;
  const r = await recentMedia(t, { limit, since }, { fetchImpl, cfg });
  if (!r.ok) return { ok: false, reason: r.reason, error: r.error };
  const items = r.items;

  if (idemMarker) {
    const hit = items.find(m => typeof m?.caption === 'string' && m.caption.includes(idemMarker));
    if (hit) return { ok: true, mediaId: String(hit.id), matchedBy: 'marker' };
  }
  if (captionSha) {
    const hit = items.find(m => typeof m?.caption === 'string'
      && sha256(normalizeCaption(m.caption).slice(0, 200)) === captionSha);
    if (hit) return { ok: true, mediaId: String(hit.id), matchedBy: 'caption-sha' };
  }
  if (newerTs) {
    const cutoff = new Date(newerTs).getTime();
    const newer = items.some(m => {
      const ts = Date.parse(m?.timestamp ?? '');
      return Number.isFinite(ts) && Number.isFinite(cutoff) && ts > cutoff;
    });
    if (newer) return { ok: true, mediaId: null, ambiguous: true };
  }
  return { ok: true, mediaId: null, ambiguous: false };
}

// ── 오류 분류 ────────────────────────────────────────────────────────────────

/**
 * Meta 오류 → 상위가 회복 경로를 고를 수 있는 라벨.
 * `token-expired`·`permission` 은 재시도해도 절대 낫지 않는다(사람의 재인증이 필요).
 */
export function classifyMetaError(status, body) {
  const err = body?.error || body || {};
  const code = Number(err.code);
  const sub = Number(err.error_subcode);
  const type = String(err.type || '');
  const msg = String(err.message || body?.raw || '');

  if (code === 190 || type === 'OAuthException') return 'token-expired';
  if (code === 10 || code === 200) return 'permission';
  if (code === 2207003 || sub === 2207003 || /2207(003|004|008|020|026)/.test(msg)) return 'media-fetch';
  if (/container/i.test(msg) && /expir/i.test(msg)) return 'container-expired';
  if ([4, 17, 32, 613].includes(code)) return 'rate';
  if (Number(status) >= 500) return 'transient';
  return 'unknown';
}
