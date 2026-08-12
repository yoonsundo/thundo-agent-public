/**
 * notify/telegram.mjs — Telegram 알림 어댑터
 * §D6 이벤트 타입: RUN_START·BUDGET_PREEMPT·SUCCESS/PARTIAL·PUBLISH_FAIL·
 *   ROLLBACK·DISCARD_MAXRETRY·KILL_ACTIVE·BUDGET_KILL·MISSED_RUN·TRIPWIRE
 * mock: 콘솔 출력 + .mock-out/notify.log
 * live: Telegram Bot API sendMessage
 * 페이로드는 외부사실만 (url+status+sha, 자기보고 금지)
 */

import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isMock, env, paths } from '../lib/config.mjs';
import { forceLive } from './live-override.mjs';

// ─── mock 로그 ────────────────────────────────────────────────────────────────

function writeMockLog(entry) {
  const dir = paths.mockOut;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const line = JSON.stringify(entry) + '\n';
  appendFileSync(join(dir, 'notify.log'), line, 'utf8');
}

// ─── Telegram live 송신 ───────────────────────────────────────────────────────

async function postMessage(botToken, chatId, text, parseMode) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body = { chat_id: chatId, text };
  if (parseMode) body.parse_mode = parseMode;
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    const err = new Error(`Telegram API 오류 ${res.status}: ${errBody}`);
    err.status = res.status;
    err.body   = errBody;
    throw err;
  }
  return res.json();
}

/**
 * Markdown 으로 먼저 보내고, **파싱 실패(400)면 평문으로 재시도**한다.
 *
 * 왜 (2026-07-30 실측): analytics-collect 의 수집실패 경보가 사유에 YouTube API 의 원시 JSON
 * (중괄호·따옴표·역슬래시)을 담았고, Telegram 이 `can't parse entities: Can't find end of the
 * entity starting at byte offset 249` 로 400 을 냈다 → **가장 중요한 경보가 텔레그램에 도달하지
 * 못했다**(Discord 는 성공해 부분 전달로 끝났다).
 *
 * 서식은 가독성 편의일 뿐이고 **도달이 본질**이다. 그래서 서식 때문에 메시지를 잃지 않는다.
 * 보내는 쪽에서 이스케이프를 강제하는 방식은 호출처가 늘어날수록 반드시 새는 지점이 생기므로
 * (경보 문구는 외부 API 문자열을 그대로 실어오는 게 정상), 어댑터에서 폴백하는 쪽을 택했다.
 */
async function sendTelegramMessage(botToken, chatId, text) {
  try {
    return await postMessage(botToken, chatId, text, 'Markdown');
  } catch (e) {
    const parseFailure = e.status === 400 && /can't parse entities|can't find end of/i.test(e.body || '');
    if (!parseFailure) throw e;
    console.warn('[notify/telegram] Markdown 파싱 실패 — 평문으로 재전송');
    return postMessage(botToken, chatId, text, null);
  }
}

// ─── 메시지 포맷 ──────────────────────────────────────────────────────────────

function formatMessage(event, payload) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const lines = [`*[blog-publisher]* \`${event}\``, `시각: ${ts}`];

  if (payload.url)     lines.push(`URL: ${payload.url}`);
  if (payload.status)  lines.push(`상태: ${payload.status}`);
  if (payload.sha)     lines.push(`SHA: \`${payload.sha}\``);
  if (payload.reason)  lines.push(`사유: ${payload.reason}`);
  if (payload.budget)  lines.push(`예산: ${JSON.stringify(payload.budget)}`);
  if (payload.details) lines.push(`상세: ${payload.details}`);

  return lines.join('\n');
}

// ─── 공개 API ─────────────────────────────────────────────────────────────────

/**
 * sendTelegram(event, payload) → void
 * payload: { url?, status?, sha?, reason?, budget?, details? } — 외부사실만
 */
export async function sendTelegram(event, payload = {}) {
  const text  = formatMessage(event, payload);
  const entry = {
    channel:    'telegram',
    event,
    payload,
    text,
    sent_at:    new Date().toISOString(),
    mock:       isMock(),
  };

  // 운영 경보(NOTIFY_FORCE_LIVE=1)는 mock 게이트를 넘는다 — 근거는 live-override.mjs.
  // RUN_MODE 는 파이프라인 시뮬레이션 여부이지, 사람에게 알릴지 여부가 아니다.
  if (isMock() && !forceLive()) {
    console.log(`[notify/telegram] MOCK ${event}:`, text);
    writeMockLog(entry);
    return { delivery: 'mock' };
  }

  const botToken = env('TELEGRAM_BOT_TOKEN');
  const chatId   = env('TELEGRAM_CHAT_ID');

  if (!botToken || !chatId) {
    console.warn('[notify/telegram] 크리덴셜 없음 — 콘솔 출력으로 대체');
    console.log(text);
    writeMockLog({ ...entry, mock: true, reason: 'no_credentials' });
    // 'sent' 이 아니라고 분명히 말한다 — 안 보냈는데 ok 로 보고하면
    // 다음 검증이 또 자기확인이 된다(2026-07-23 리뷰 지적).
    return { delivery: 'console-fallback' };
  }

  await sendTelegramMessage(botToken, chatId, text);
  console.log(`[notify/telegram] 전송 완료: ${event}`);
  return { delivery: 'sent' };
}
