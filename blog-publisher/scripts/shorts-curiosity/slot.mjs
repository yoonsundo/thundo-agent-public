#!/usr/bin/env node
/**
 * shorts-curiosity/slot.mjs — 시차 발행 슬롯 러너 (cron 10/12/18 KST 각 호출).
 *
 * "한번에 발행 X — 시간 텀 두고 최적시간 자동 발행"(2026-07-14 사용자). 슬롯마다 best-pick
 * 1편을 produce+upload 하되, **일일 상한(daily_cap, 기본 3)** 을 넘지 않게 가드한다
 * (슬롯 중복 발화·재실행에도 하루 3편 초과 발행 안 함 — 멱등).
 *
 * ── US-008 무결방 가드 (2026-07-30 신설) ────────────────────────────────────
 * 2026-07-25·26 에 claude -p 지속성 장애로 3개 슬롯이 전멸해 **업로드 0편 × 2일 연속**이
 * 났고, 그 사실이 gitignore 된 runs/*.log 에만 남아 사용자가 이틀 연속 결방을 몰랐다.
 * 신생 채널(07-13 개설)에 연속 결방은 치명적이다. 그래서 이 슬롯은 3중으로 방어한다:
 *   ① 결방 경보  — 슬롯이 0편으로 끝나면 Telegram/Discord 로 즉시 알린다(무음 실패 제거).
 *   ② 재고 폴백  — 신규 제작(claude)이 죽으면 produced 재고를 즉시 업로드해 슬롯을 채운다.
 *   ③ 당일 결손 보충 — 앞 슬롯이 비었으면 이번 슬롯이 결손분까지 채운다(단, 상한 3편 엄수).
 * 전일 결손은 소급 보충하지 않는다(과다발행·주제 급증 위험) — 경보로만 알린다.
 *
 * 환경변수:
 *   CURIOSITY_SLOT_N   이 슬롯에서 만들 편수(기본 1, 결손 보충 시 자동 증가)
 *   CURIOSITY_FORCE=1  일일 상한 무시(오늘 킥스타트 등 일회성)
 *   CURIOSITY_DAILY_CAP 하루 상한(기본 config.upload.daily_cap || 3)
 *   CURIOSITY_SLOT_HOURS 슬롯 시각(KST, 기본 "10,12,18") — 결손 기대치 계산용
 *   CURIOSITY_SLOT_KEY  경보 중복 방지 마커 키(기본 현재 KST 시각 HH)
 *
 * 계약: stdout JSON. exit 0=정상(스킵 포함)/1=발행 실패/2=제작 예외(기존 신호 보존).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeLogger } from '../lib/log.mjs';
import { paths } from '../lib/config.mjs';
import { loadConfig, loadIndex, isMainModule, loadLastClaudeFailure, FAILURE_LABELS, failureAction } from './lib.mjs';
import { runDaily, uploadProducedFallback } from './run-curiosity.mjs';
import { uploadReadiness } from '../shorts/upload.mjs';
import { notify, EVENTS } from '../notify/index.mjs';
import { assessInventory, refillInventory, inventoryCount } from './inventory.mjs';

const log = makeLogger('curiosity/slot');

/** KST 기준 YYYY-MM-DD. */
function kstDate(iso) {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}

/** KST 기준 시각(0~23). hourCycle=h23 로 자정이 '24' 로 나오는 로케일 함정을 피한다. */
export function kstHour(now = new Date()) {
  const s = new Date(now).toLocaleString('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', hourCycle: 'h23' });
  const h = parseInt(String(s).replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(h) ? h % 24 : 0;
}

/** 오늘(KST) 업로드된 편수. markStatus 는 타임스탬프를 `at` 로, 초기 시드는 `uploaded_at` 로
 *  기록하므로 둘 다 허용(둘 다 없으면 카운트 제외 — 상한 가드 멱등성 보장). */
export function uploadedToday(index, now = new Date()) {
  const today = kstDate(now.toISOString ? now.toISOString() : now);
  return Object.values(index).filter(v => {
    if (v.status !== 'uploaded') return false;
    const ts = v.uploaded_at || v.at;
    return ts && kstDate(ts) === today;
  }).length;
}

/** 슬롯 시각 목록(KST). cron(10/12/18)과 일치시켜 두면 결손 기대치가 정확해진다. */
export function slotSchedule() {
  const hours = String(process.env.CURIOSITY_SLOT_HOURS || '10,12,18')
    .split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite).sort((a, b) => a - b);
  return hours.length ? hours : [10, 12, 18];
}

/**
 * 당일 결손 보충 계획 — "지금까지 몇 편 나갔어야 하는가(expected)" 대비 실제(already)의
 * 차이를 이번 슬롯이 흡수한다. 마지막 슬롯이면 expected=cap 이므로 하루치를 통째로 시도한다
 * (예: 오늘 0/3 이고 18시 슬롯 → 3편). 상한 초과는 remaining 으로 잘라 절대 금지.
 * @returns {{n:number, expected:number, deficit:number, slotIndex:number, isLast:boolean, remaining:number}}
 */
export function slotPlan({ now = new Date(), cap = 3, already = 0, want = 1 } = {}) {
  const hours = slotSchedule();
  const h = kstHour(now);
  const passed = hours.filter(x => x <= h).length;           // 현재 슬롯 포함 경과 슬롯 수
  const slotIndex = Math.max(1, passed);                      // 첫 슬롯 이전 수동 실행도 1로 간주
  const isLast = slotIndex >= hours.length;
  const expected = isLast ? cap : Math.min(cap, Math.ceil((cap * slotIndex) / hours.length));
  const deficit = Math.max(0, expected - already);
  const remaining = Math.max(0, cap - already);
  const n = Math.min(Math.max(want, deficit), remaining);
  return { n, expected, deficit, slotIndex, isLast, remaining };
}

/** runDaily 반환에서 "실제 업로드된 편수" 세기 — 단일경로/병행(best_n>=2) 두 형태 모두 지원. */
export function countUploads(result) {
  if (!result || typeof result !== 'object') return 0;
  if (Array.isArray(result.produced)) return result.produced.filter(p => p && p.youtube).length;
  return result.youtube ? 1 : 0;
}

/** 결방 경보 중복 방지 마커 경로 — 날짜+슬롯 단위(다른 슬롯 실패는 각각 알린다). */
export function alertMarkerPath({ now = new Date(), slotKey } = {}) {
  const key = slotKey || process.env.CURIOSITY_SLOT_KEY || String(kstHour(now)).padStart(2, '0');
  return join(paths.state, 'shorts-curiosity', 'alerts', `nogap-${kstDate(now.toISOString())}-slot${key}.marker`);
}

/**
 * 경보 본문용 문자열 정제 — **원시 JSON·Markdown 활성문자를 제거**한다.
 * 왜: 2026-07-30 다른 경보가 원시 JSON 때문에 Telegram Markdown 파싱을 깨뜨려 도달하지
 * 못했다(어댑터에 평문 폴백이 생겼지만, 본문은 애초에 사람이 읽을 수 있어야 한다).
 * 원문 전체는 state/shorts-curiosity/last-claude-failure.json 과 runs/*.log 에 남는다.
 */
export function sanitizeForAlert(text, max = 220) {
  const s = String(text ?? '')
    .replace(/[{}[\]"`*_\\]/g, ' ')     // JSON 괄호·따옴표 + Markdown 활성문자 제거
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * 진단(diag) → 사람이 읽는 경보 줄들. 원시 JSON 없이 "무엇이 원인이고 무엇을 하면 되는가"만.
 * diag 는 lib.mjs callClaude 가 err.diag / last-claude-failure.json 으로 남긴 구조체.
 */
export function describeDiag(diag) {
  if (!diag) return [];
  const kind = diag.kind || 'unknown';
  const label = FAILURE_LABELS[kind] || FAILURE_LABELS.unknown;
  const lines = [`진단: ${label} (${kind}, 확신 ${diag.confidence || 'low'})`];
  lines.push(`조치: ${sanitizeForAlert(diag.action || failureAction(kind), 260)}`);
  const sig = [
    `exit=${diag.exit_code ?? '-'}`,
    `signal=${diag.signal || '없음'}`,
    diag.error_code ? `code=${diag.error_code}` : null,
    `시도 ${diag.attempts ?? '?'}/${diag.max_attempts ?? '?'}회`,
    Number.isFinite(diag.elapsed_ms) ? `${(diag.elapsed_ms / 1000).toFixed(1)}초` : null,
    diag.cli_version ? `CLI ${sanitizeForAlert(diag.cli_version, 40)}` : 'CLI 버전조회 실패',
    diag.stderr_empty ? 'stderr 비어있음' : null,
    diag.aborted_early ? '재시도 생략됨' : null,
  ].filter(Boolean).join(' ');
  lines.push(`신호: ${sig}`);
  if (diag.evidence) lines.push(`근거: ${sanitizeForAlert(diag.evidence, 140)}`);
  const raw = diag.stdout_excerpt || diag.stderr_excerpt || diag.message;
  if (raw) lines.push(`출력 요약: ${sanitizeForAlert(raw, 200)}`);
  return lines;
}

/**
 * 결방 경보 페이로드 — 사람이 바로 판단할 수 있게 진행상황·원인 진단·재고·조치를 담는다.
 * (notify 어댑터가 지원하는 필드는 reason/details 뿐이므로 details 에 사실을 나열한다)
 * ⚠ 원시 JSON 금지 — 모든 외부 문자열은 sanitizeForAlert 를 통과시킨다.
 */
export function buildNoGapPayload({ now = new Date(), slotKey, already = 0, cap = 3, planned = 0, produceError = null, inventory = 0, fallbackTried = 0, pickReason = null, diag = null } = {}) {
  const key = slotKey || String(kstHour(now)).padStart(2, '0');
  const date = kstDate(now.toISOString ? now.toISOString() : now);
  const parts = [
    `오늘 진행: ${already}/${cap}편 (이번 슬롯 목표 ${planned}편 → 0편)`,
    `재고(produced 미업로드): ${inventory}편${fallbackTried ? ` / 폴백 시도 ${fallbackTried}편` : ''}`,
    produceError ? `실패 사유: ${sanitizeForAlert(produceError, 240)}`
      : (pickReason ? `제작 중단: ${sanitizeForAlert(pickReason, 200)}` : '실패 사유: 업로드 결과 0편(사유 미보고)'),
    ...describeDiag(diag),
  ];
  // 진단이 없거나 unknown 이면 사람이 직접 확인할 순서를 남긴다(경보 한 통으로 끝나게).
  if (!diag || diag.kind === 'unknown') {
    parts.push('확인할 것: ① claude 구독 사용량 한도 소진 여부(터미널에서 claude -p 수동 1회) ② 네트워크·YouTube OAuth 토큰 ③ 재고 0이면 버퍼 보충 필요');
  }
  parts.push('전체 로그: runs/curiosity-slot-<날짜>.log · state/shorts-curiosity/last-claude-failure.json');
  return {
    reason: `⚠ 호기심 쇼츠 결방 — ${date} ${key}시 슬롯 발행 0편 (오늘 ${already}/${cap})${diag ? ` · 원인 ${diag.kind}` : ''}`,
    details: parts.join(' | '),
  };
}

/**
 * 결방 경보 발송 — 마커로 같은 날 같은 슬롯 중복 발송을 막고, **반환값 sent 로 도달을 확인**한다.
 * ⚠ 이 박스는 필수 크리덴셜 누락으로 config 가 항상 mock 으로 강등된다 → 운영 경보는
 *    NOTIFY_FORCE_LIVE=1 이 없으면 .mock-out/notify.log 에만 적히고 사람에게 도달하지 않는다
 *    (근거: scripts/notify/live-override.mjs, crosspub/analytics-collect 관례).
 * ⚠ 경보 실패가 슬롯을 죽이면 안 된다 — 모든 예외를 흡수하고 결과만 보고한다.
 */
export async function alertNoGap({ notifier = notify, now = new Date(), slotKey, ...info } = {}) {
  const marker = alertMarkerPath({ now, slotKey });
  const payload = buildNoGapPayload({ now, slotKey, ...info });

  try {
    if (existsSync(marker)) {
      log.warn(`결방 경보 이미 발송됨(${marker}) → 중복 발송 생략`);
      return { alerted: false, skipped: 'slot-marker', marker, payload };
    }
  } catch (e) {
    log.warn(`마커 확인 실패(경보는 계속): ${e.message}`);
  }

  process.env.NOTIFY_FORCE_LIVE = '1';   // forceLive() 는 호출 시점 env 를 읽는다
  let delivery;
  try {
    // 전용 이벤트 타입이 없어 MISSED_RUN(결방/미실행)으로 싣는다 — 사유 문구에 맥락을 담는다.
    delivery = await notifier(EVENTS.MISSED_RUN, payload);
  } catch (e) {
    log.error(`결방 경보 발송 자체 실패: ${e?.message || e}`);
    delivery = { telegram: 'error', discord: 'error' };
  }

  const sent = !!delivery && (delivery.telegram === 'sent' || delivery.discord === 'sent');
  if (sent) log.info(`결방 경보 발송됨 — telegram=${delivery.telegram} discord=${delivery.discord}`);
  else log.warn(`결방 경보가 사람에게 도달하지 않았다(크리덴셜 확인) — ${JSON.stringify(delivery)}`);

  try {
    mkdirSync(join(paths.state, 'shorts-curiosity', 'alerts'), { recursive: true });
    writeFileSync(marker, `${new Date().toISOString()} ${payload.reason}\n`, 'utf8');
  } catch (e) {
    log.warn(`경보 마커 기록 실패(다음 슬롯에서 재발송될 수 있음): ${e.message}`);
  }

  return { alerted: true, sent, delivery, marker, payload };
}

/**
 * 슬롯 1회 실행.
 * @param {object} [p]
 * @param {object} [p.cfg]  config (미지정 시 loadConfig)
 * @param {object} [p.deps] 테스트 주입점 — runDaily/uploadProducedFallback/loadIndex/notifier/
 *                          uploadReadiness/refillInventory/alertNoGap/now
 */
export async function runSlot({ cfg, deps = {} } = {}) {
  const d = {
    runDaily, uploadProducedFallback, loadIndex, notifier: notify,
    uploadReadiness, refillInventory, alertNoGap, loadLastClaudeFailure, now: new Date(),
    ...deps,
  };
  cfg = cfg || loadConfig();
  // 하루 상한 = 사용자 룰 3편. config 는 두 곳에 표현될 수 있어 둘 다 읽는다
  // (upload.daily_cap 이 명시되면 우선, 없으면 pick.daily_target, 둘 다 없으면 3).
  const cap = Number(process.env.CURIOSITY_DAILY_CAP) || cfg.upload?.daily_cap || cfg.pick?.daily_target || 3;
  const force = process.env.CURIOSITY_FORCE === '1';
  const want = Number(process.env.CURIOSITY_SLOT_N) || 1;

  const index = d.loadIndex();
  const already = uploadedToday(index, d.now);
  // 업로드 자체가 불가능한 환경(staged·토큰 없음)에서는 경보를 울리지 않는다 —
  // 그런 "0편"은 장애가 아니라 설정이고, 매 슬롯 오탐 경보는 채널을 무시당하게 만든다.
  const readiness = d.uploadReadiness(cfg);

  // ── 상한 가드: 이미 3편이면 아무것도 하지 않는다(사용자 룰, 멱등) ──
  if (!force && already >= cap) {
    log.info(`일일 상한 도달(${already}/${cap}) → 스킵`);
    return { ok: true, skipped: 'daily_cap', already, cap };
  }

  // ── 당일 결손 보충 계획 ──
  const plan = slotPlan({ now: d.now, cap, already, want });
  const n = force ? Math.max(1, want) : plan.n;
  if (n <= 0) {
    log.info(`발행 잔여 없음(${already}/${cap}) → 스킵`);
    return { ok: true, skipped: 'daily_cap', already, cap };
  }
  if (!force && plan.deficit > want) {
    log.warn(`당일 결손 감지 — 기대 ${plan.expected}편 대비 실제 ${already}편 → 이번 슬롯 ${n}편으로 보충 시도`);
  }

  // ── 신규 제작 + 발행 (claude 장애는 여기서 예외로 터진다: 2026-07-25/26 종료코드 2) ──
  const runCfg = { ...cfg, pick: { ...cfg.pick, best_n: n } };
  log.info(`슬롯 발행 시작: n=${n} (오늘 ${already}/${cap}${force ? ', FORCE' : ''}, 기대 ${plan.expected})`);
  let result = null, produceError = null, produceDiag = null;
  try {
    result = await d.runDaily({ cfg: runCfg });
  } catch (e) {
    produceError = e.message;
    // callClaude 가 첨부한 진단(exit code·stdout·분류)을 그대로 받는다 — 없으면 아래에서 파일 폴백.
    produceDiag = e?.diag || null;
    log.error(`신규 제작 실패 → 재고 폴백 시도: ${e.message}`, produceDiag ? { kind: produceDiag.kind, confidence: produceDiag.confidence } : undefined);
  }
  let uploads = countUploads(result);

  // ── 재고 폴백: 이번 슬롯 목표(n)에 미달분을 produced 재고로 채운다(상한 이중 가드) ──
  let fallback = [];
  const need = Math.min(Math.max(0, n - uploads), Math.max(0, cap - (already + uploads)));
  if (need > 0 && readiness.ready) {
    log.info(`슬롯 미달(${uploads}/${n}) → 재고 폴백 ${need}편 시도`);
    try {
      fallback = (await d.uploadProducedFallback(cfg, need)) || [];
    } catch (e) {
      log.warn(`재고 폴백 실패(비차단): ${e.message}`);
    }
  } else if (need > 0) {
    log.info(`슬롯 미달(${uploads}/${n})이나 업로드 불가 환경 → 폴백 생략: ${readiness.reason}`);
  }
  const fbUploads = fallback.filter(f => f && f.youtube).length;
  const slotUploads = uploads + fbUploads;
  const todayTotal = already + slotUploads;

  // ── 결방 경보: 이번 슬롯이 0편으로 끝났고, 발행 가능한 환경이었을 때만 ──
  let alert = null, diag = produceDiag;
  if (slotUploads === 0 && readiness.ready) {
    // 예외가 중간(run-curiosity 의 후보별 try/catch 등)에서 흡수돼 err.diag 가 안 올라온
    // 경우까지 원인을 붙인다 — callClaude 가 남긴 최근 진단 파일을 읽는다(오래된 건 무시).
    if (!diag) {
      try { diag = d.loadLastClaudeFailure({ maxAgeMs: 45 * 60 * 1000 }); }
      catch (e) { log.warn(`최근 claude 진단 로드 실패(무시): ${e.message}`); diag = null; }
    }
    if (diag) log.error(`결방 원인 진단: ${diag.kind}/${diag.confidence} — ${diag.action}`);
    try {
      alert = await d.alertNoGap({
        notifier: d.notifier, now: d.now, already: todayTotal, cap, planned: n,
        produceError, inventory: inventoryCount(d.loadIndex(), cfg), fallbackTried: need,
        pickReason: result?.reason || null, diag,
      });
    } catch (e) {
      // 경보 경로의 어떤 실패도 슬롯을 죽이지 않는다(발행 로직 우선).
      log.error(`결방 경보 처리 예외(무시): ${e.message}`);
      alert = { alerted: false, error: e.message };
    }
  }

  // ── 재고 버퍼 보충: claude 가 건강하고(제작 성공) 오늘 몫을 다 채운 뒤에만 여유 제작 ──
  let refill = null;
  const inv = assessInventory({ cfg, index: d.loadIndex() });
  if (!produceError && slotUploads > 0 && todayTotal >= cap && inv.refillN > 0) {
    try {
      refill = await d.refillInventory({ cfg, need: inv.refillN, produce: d.runDaily });
    } catch (e) {
      log.warn(`재고 보충 예외(비차단): ${e.message}`);
      refill = { ok: false, error: e.message };
    }
  }

  // ── exit 계약: 경보 발송 여부가 종료코드를 바꾸지 않는다(cron 오탐 방지) ──
  // 발행 가능 환경이면 "슬롯이 실제로 채워졌는가"가 성공 기준. staged 환경은 기존 계약 유지.
  let ok, exit;
  if (!readiness.ready) {
    ok = result ? result.ok !== false : false;
    exit = ok ? 0 : (produceError ? 2 : 1);
  } else {
    ok = slotUploads > 0;
    exit = ok ? 0 : (produceError ? 2 : 1);   // 제작 예외는 기존 종료코드 2 신호 보존
  }

  return {
    ok, exit, slot_n: n, force, already, cap, today_total: todayTotal,
    uploads, fallback_uploads: fbUploads, fallback, plan,
    upload_ready: readiness.ready, upload_block: readiness.ready ? undefined : readiness.reason,
    produce_error: produceError, inventory: inv, refill, alert, result,
    // 진단 요약만 stdout 계약에 실어 cron 로그에서 바로 갈래를 볼 수 있게 한다(원문은 진단 파일).
    diagnosis: diag ? { kind: diag.kind, confidence: diag.confidence, exit_code: diag.exit_code, signal: diag.signal, attempts: diag.attempts, cli_version: diag.cli_version, stderr_empty: diag.stderr_empty } : null,
  };
}

async function main() {
  try {
    const r = await runSlot();
    process.stdout.write(JSON.stringify(r) + '\n');
    process.exit(Number.isFinite(r.exit) ? r.exit : (r.ok ? 0 : 1));
  } catch (e) {
    log.error(`슬롯 오류: ${e.message}`);
    process.stdout.write(JSON.stringify({ ok: false, reason: e.message }) + '\n');
    process.exit(2);
  }
}

if (isMainModule(import.meta.url)) main();
