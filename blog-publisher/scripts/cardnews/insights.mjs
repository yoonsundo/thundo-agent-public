#!/usr/bin/env node
/**
 * cardnews/insights.mjs — 인스타그램 성과 수집 (**읽기 전용**)
 *
 * 이 채널의 1차 성공지표는 **저장(saved)** 인데, 그걸 읽는 코드가 한 줄도 없었다.
 * 성과를 **읽는 것**과 그걸로 **설정을 자동 조정하는 것**은 별개다 — 여기는 읽기만 한다.
 * 설정 변형(자가발전)은 v1.1 소관이며 이 파일은 config 를 **절대 쓰지 않는다**.
 *
 * 지금 만드는 이유는 취향이 아니라 비대칭이다: 인스타 인사이트는 **소급 조회 창이 유한**하다.
 * 첫 발행 시점부터 수집이 돌지 않으면 그 데이터는 영구히 사라진다. 지금은 아직
 * `publish.enabled=false` 라 가장 싼 순간이다.
 *
 * 설계 규칙 4가지:
 *  ① **append-only, upsert 금지** — 같은 글을 1일/7일/30일에 각각 한 줄씩 남긴다. 저장이
 *     늦게 붙는지(=콘텐츠가 늦게 발견되는지)는 곡선으로만 보이지, 최신값 덮어쓰기로는 안 보인다.
 *  ② **절대 throw 하지 않는다** — 실패한 글은 `{error_class}` 로 한 줄 남기고 다음으로 간다.
 *     한 건의 삭제된 미디어가 그날 수집 전체를 죽이면 안 된다(meta.mjs 와 같은 정책).
 *  ③ **fail-closed on token** — 토큰이 없거나 만료면 네트워크를 건드리기 전에 멈춘다.
 *     만료 토큰으로 계속 두드리면 rate limit 만 태우고 아무것도 못 얻는다.
 *  ④ **read 라서 guardPublish 가 필요 없다** — 이건 발행 초크포인트를 우회하는 게 아니라,
 *     애초에 발행 경로가 아니다. 여기에 쓰기 호출을 추가하지 말 것.
 *
 * ⚠ 메트릭 이름은 미디어 타입별로 다르고 Meta 가 버전마다 바꾼다. 그리고 Graph 는
 * **이름 하나만 거부돼도 요청 전체를 400 으로 떨군다**(부분 응답이 없다). 그래서 전체 세트를
 * 한 번 시도하고, 이름 거부면 core 세트로 **딱 한 번** 축소 재시도한다(`degraded:true`).
 * 이 폴백이 없으면 `profile_visits` 하나 때문에 saved 까지 통째로 못 읽는다.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, loadIndex, stateRoot, isMainModule } from './lib.mjs';
import { loadToken, classifyMetaError } from './meta.mjs';
import { makeLogger } from '../lib/log.mjs';

const log = makeLogger('cardnews/insights');

/**
 * 전체 세트 — 계획이 지목한 다섯. `saved` 가 1차 지표, `reach` 는 그 분모다.
 * ⚠ `profile_visits` 는 프로 계정·미디어 타입에 따라 거부될 수 있어 core 에서 뺐다.
 */
export const ALL_METRICS = ['saved', 'shares', 'reach', 'profile_visits', 'total_interactions'];

/** 캐러셀(CAROUSEL_ALBUM)에서 실측 지원이 확실한 최소 세트 — 폴백 대상. */
export const CORE_METRICS = ['saved', 'shares', 'reach', 'total_interactions'];

export function insightsPath() { return join(stateRoot(), 'insights.jsonl'); }

// ── 응답 파싱 ────────────────────────────────────────────────────────────────

/** 응답 본문을 JSON 으로 최대한 읽되, 실패해도 throw 하지 않는다(meta.mjs readBody 미러). */
async function readBody(res) {
  try { return await res.json(); } catch { /* JSON 아님 */ }
  try { return { raw: (await res.text()).slice(0, 300) }; } catch { return {}; }
}

/**
 * `{data:[{name, values:[{value}]}]}` 와 신형 `{data:[{name, total_value:{value}}]}` 를 모두 읽는다.
 * 없는 메트릭은 키를 만들지 않는다 — `0` 으로 채우면 "0회 저장"과 "못 읽음"이 구별되지 않는다.
 */
export function parseInsights(body) {
  const out = {};
  const items = Array.isArray(body?.data) ? body.data : [];
  for (const it of items) {
    const name = String(it?.name || '');
    if (!name) continue;
    let v = it?.total_value?.value;
    if (v === undefined) v = Array.isArray(it?.values) ? it.values[0]?.value : undefined;
    const n = Number(v);
    if (Number.isFinite(n)) out[name] = n;
  }
  return out;
}

/**
 * "메트릭 이름을 못 알아듣는다" 를 다른 400 과 구별한다. 이걸 구별해야 축소 재시도가
 * 정당해진다 — 권한·만료에는 재시도가 무의미하다.
 *
 * ⚠ **code 100 만 보고 판단하면 안 된다.** Meta 는 100 을 "잘못된 메트릭 이름"과
 * "이 미디어엔 아직 인사이트가 없다" 양쪽에 재사용한다(실측). 코드만 믿으면 후자를
 * 전자로 오분류해 무의미한 재시도를 하고, 곡선에는 틀린 라벨이 박힌다. 그래서
 * **본문이 실제로 메트릭을 지목할 때만** 참이다.
 */
export function isInvalidMetricError(status, body, requested = []) {
  if (Number(status) !== 400) return false;
  const msg = String(body?.error?.message || body?.raw || '');
  if (!/metric/i.test(msg)) return false;
  return requested.some(m => msg.includes(m)) || /valid\s+(insights\s+)?metric|unsupported\s+metric/i.test(msg);
}

/**
 * "아직 인사이트가 없다"(너무 최근·데이터 부족)를 영구 실패와 구별한다.
 * 이건 내일 다시 부르면 낫는다 — held 로 내릴 일이 아니라 다음 수집을 기다릴 일이다.
 */
export function isUnavailableError(body) {
  const msg = String(body?.error?.message || body?.raw || '');
  return /not\s+available|insufficient|too\s+(new|recent)|not\s+enough\s+data|posted\s+long\s+enough/i.test(msg);
}

// ── 단건 조회 ────────────────────────────────────────────────────────────────

/**
 * 미디어 1건의 인사이트. **throw 하지 않는다.**
 *
 * @returns {Promise<{ok:true, metrics:Object, requested:string[], degraded:boolean, dropped:string[]}
 *                  |{ok:false, error_class:string, reason:string, status?:number}>}
 */
export async function fetchInsights(mediaId, token, { fetchImpl = fetch, cfg, metrics, timeoutMs } = {}) {
  if (!mediaId) return { ok: false, error_class: 'invalid-input', reason: 'media_id 없음' };
  if (!token?.access_token) return { ok: false, error_class: 'token-expired', reason: '토큰 없음(fail-closed)' };

  const requested = (metrics && metrics.length ? metrics : (cfg?.insights?.metrics || ALL_METRICS)).slice();
  const core = (cfg?.insights?.core_metrics || CORE_METRICS).filter(m => requested.includes(m));
  const ms = timeoutMs || cfg?.insights?.request_timeout_ms || 15000;

  const attempt = async (want) => {
    // endpoint/authHeaders 를 다시 만들지 않는다 — meta.mjs 의 규약을 그대로 쓴다.
    const base = cfg?.meta?.graph_base || token?.graph_base || 'https://graph.instagram.com';
    const ver = cfg?.meta?.api_version || token?.api_version || 'v25.0';
    const url = `${base}/${ver}/${encodeURIComponent(mediaId)}/insights?metric=${encodeURIComponent(want.join(','))}`;
    let res, body;
    try {
      res = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${token.access_token}` },
        signal: AbortSignal.timeout(ms),
      });
      body = await readBody(res);
    } catch (e) {
      return { ok: false, error_class: 'transient', reason: `네트워크/타임아웃: ${e.message}` };
    }
    if (res.status >= 300) {
      const invalidMetric = isInvalidMetricError(res.status, body, want);
      const error_class = invalidMetric ? 'invalid-metric'
        : isUnavailableError(body) ? 'insights-unavailable'
          : classifyMetaError(res.status, body);
      return { ok: false, status: res.status, error_class, reason: `HTTP ${res.status}` };
    }
    return { ok: true, metrics: parseInsights(body) };
  };

  const first = await attempt(requested);
  if (first.ok) return { ...first, requested, degraded: false, dropped: [] };

  // 이름 거부일 때만, core 로 **한 번만** 축소 재시도. 그 외에는 재시도하지 않는다.
  if (first.error_class === 'invalid-metric' && core.length && core.length < requested.length) {
    const second = await attempt(core);
    if (second.ok) {
      const dropped = requested.filter(m => !core.includes(m));
      log.warn(`인사이트 메트릭 거부 → core 폴백 (제외: ${dropped.join(',')})`, { mediaId });
      return { ...second, requested: core, degraded: true, dropped };
    }
    return second;
  }
  return first;
}

// ── 전량 수집 ────────────────────────────────────────────────────────────────

function ageDays(publishedAt, now) {
  const t = Date.parse(publishedAt ?? '');
  if (!Number.isFinite(t)) return null;
  return Math.round(((now.getTime() - t) / 86400000) * 100) / 100;
}

function appendRecord(rec) {
  const p = insightsPath();
  mkdirSync(stateRoot(), { recursive: true });
  appendFileSync(p, JSON.stringify(rec) + '\n', 'utf8');   // ⛔ upsert 금지 — 성장곡선이 신호다
  return rec;
}

/**
 * `index.json` 을 훑어 `published_media_id` 가 있는 글마다 인사이트 1줄을 append 한다.
 *
 * fail-closed 지점 둘:
 *  - 토큰이 없거나 필수 키가 빠지면 **네트워크 없이** 즉시 중단(파일도 안 건드린다).
 *  - 도중에 `token-expired` 가 나오면 남은 글을 **더 두드리지 않고** 중단한다. 만료 토큰은
 *    재시도로 낫지 않고, 계속 부르면 rate limit 만 태운다.
 *
 * @returns {Promise<{ok:boolean, collected:number, failed:number, skipped:number,
 *                    aborted?:boolean, reason?:string, records:Object[]}>}
 */
export async function collectAll({ cfg, now = new Date(), fetchImpl = fetch, token = null, index = null } = {}) {
  const conf = cfg || loadConfig();
  if (conf?.insights?.enabled === false) {
    return { ok: false, reason: 'insights.enabled=false', collected: 0, failed: 0, skipped: 0, records: [] };
  }

  let tok = token;
  if (!tok) {
    const r = loadToken(conf);
    if (!r.ok) return { ok: false, reason: `토큰 fail-closed: ${r.reason}`, collected: 0, failed: 0, skipped: 0, records: [] };
    tok = r.token;
  }
  if (!tok?.access_token) {
    return { ok: false, reason: '토큰 fail-closed: access_token 없음', collected: 0, failed: 0, skipped: 0, records: [] };
  }

  let idx;
  try { idx = index || loadIndex(); }
  catch (e) { return { ok: false, reason: `index.json: ${e.message}`, collected: 0, failed: 0, skipped: 0, records: [] }; }

  const posts = Object.values(idx || {}).filter(p => p && typeof p === 'object');
  const cap = Number(conf?.insights?.max_posts_per_run) || 0;
  // ⚠ 2026-08-21 반자동 발행 전환 이후 **이 필터가 사실상 모든 글을 걸러낸다.** 관리자가 인스타
  //   앱으로 직접 올리면 Graph API 를 거치지 않아 published_media_id 가 영원히 생기지 않는다.
  //   즉 도달·저장률 수집은 무인 발행(`publish.enabled=true`)일 때만 동작한다 — 반자동을 택한 대가다.
  const targets = posts.filter(p => p.published_media_id);
  const skipped = posts.length - targets.length;          // 미발행·발행실패 글은 조용히 건너뛴다
  const slice = cap > 0 ? targets.slice(0, cap) : targets;

  const collectedAt = now.toISOString();
  const records = [];
  let collected = 0, failed = 0, aborted = false, reason;

  for (const post of slice) {
    const stem = {
      collected_at: collectedAt,
      post_id: post.post_id ?? null,
      published_media_id: String(post.published_media_id),
      published_at: post.published_at ?? null,
      age_days: ageDays(post.published_at, now),
    };
    const r = await fetchInsights(stem.published_media_id, tok, { fetchImpl, cfg: conf });
    if (r.ok) {
      const m = r.metrics || {};
      records.push(appendRecord({
        ...stem,
        saved: m.saved ?? null,
        shares: m.shares ?? null,
        reach: m.reach ?? null,
        profile_visits: m.profile_visits ?? null,
        total_interactions: m.total_interactions ?? null,
        ...(r.degraded ? { degraded_metrics: r.dropped } : {}),
      }));
      collected++;
    } else {
      records.push(appendRecord({ ...stem, error_class: r.error_class, error_reason: r.reason }));
      failed++;
      if (r.error_class === 'token-expired' || r.error_class === 'permission') {
        aborted = true;                                   // 남은 글은 더 두드리지 않는다
        reason = `${r.error_class} — 남은 ${slice.length - records.length}건 중단(fail-closed)`;
        break;
      }
    }
  }

  return { ok: !aborted, collected, failed, skipped, ...(aborted ? { aborted, reason } : {}), records };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

if (isMainModule(import.meta.url)) {
  // 계약(GSC·네이버와 동일): 비활성·크리덴셜 없음·데이터 없음은 **warn + exit 0**(비차단).
  const r = await collectAll({});
  if (!r.ok) log.warn(`수집 중단: ${r.reason}`, { collected: r.collected, failed: r.failed });
  else log.info(`인사이트 수집 완료`, { collected: r.collected, failed: r.failed, skipped: r.skipped });
  console.log(JSON.stringify({
    ok: r.ok, collected: r.collected, failed: r.failed, skipped: r.skipped, reason: r.reason ?? null,
  }));
  process.exit(0);
}
