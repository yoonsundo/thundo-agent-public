/**
 * notify/discord.mjs — Discord Webhook 알림 어댑터
 * §D6 이벤트 타입 동일.
 * mock: 콘솔 출력 + .mock-out/notify.log
 * live: Discord Incoming Webhook POST
 * 페이로드는 외부사실만
 */

import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isMock, env, paths } from '../lib/config.mjs';
import { forceLive } from './live-override.mjs';

// ─── 이벤트별 색상 (Discord embed color) ─────────────────────────────────────

const EVENT_COLORS = {
  RUN_START:         0x5865F2,  // 파랑
  SUCCESS:           0x57F287,  // 녹색
  PARTIAL:           0xFEE75C,  // 노랑
  PUBLISH_FAIL:      0xED4245,  // 빨강
  ROLLBACK:          0xEB459E,  // 핑크
  DISCARD_MAXRETRY:  0xED4245,  // 빨강
  KILL_ACTIVE:       0xED4245,  // 빨강
  BUDGET_PREEMPT:    0xFEE75C,  // 노랑
  BUDGET_KILL:       0xED4245,  // 빨강
  MISSED_RUN:        0xFEE75C,  // 노랑
  TRIPWIRE:          0xFF0000,  // 선명한 빨강
  GIT_PERSIST_FAIL:  0xED4245,  // 빨강 — 발행물·감사로그가 원격에 안 남는 상태
  GIT_PERSIST_PAUSED: 0xFEE75C, // 노랑 — 의도된 일시정지(사람이 만든 상태, 실패 아님)
};

// ─── mock 로그 ────────────────────────────────────────────────────────────────

function writeMockLog(entry) {
  const dir = paths.mockOut;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const line = JSON.stringify(entry) + '\n';
  appendFileSync(join(dir, 'notify.log'), line, 'utf8');
}

// ─── Discord embed 포맷 ───────────────────────────────────────────────────────

function buildEmbed(event, payload) {
  const color  = EVENT_COLORS[event] ?? 0x99AAB5;
  const ts     = new Date().toISOString();

  const fields = [];
  if (payload.url)    fields.push({ name: 'URL',    value: payload.url,               inline: false });
  if (payload.status) fields.push({ name: '상태',   value: String(payload.status),    inline: true  });
  if (payload.sha)    fields.push({ name: 'SHA',    value: `\`${payload.sha}\``,      inline: true  });
  if (payload.reason) fields.push({ name: '사유',   value: payload.reason,            inline: false });
  if (payload.budget) fields.push({ name: '예산',   value: JSON.stringify(payload.budget), inline: false });
  if (payload.details) fields.push({ name: '상세',  value: payload.details,           inline: false });

  return {
    title:       `[blog-publisher] ${event}`,
    color,
    fields,
    timestamp:   ts,
    footer:      { text: 'blog-publisher 자동발행 파이프라인' },
  };
}

// ─── Discord Webhook 송신 ─────────────────────────────────────────────────────

async function postWebhook(webhookUrl, embed) {
  const res = await fetch(webhookUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ embeds: [embed] }),
    signal:  AbortSignal.timeout(15_000),
  });
  if (!res.ok && res.status !== 204) {
    const body = await res.text().catch(() => '');
    throw new Error(`Discord Webhook 오류 ${res.status}: ${body}`);
  }
}

// ─── 공개 API ─────────────────────────────────────────────────────────────────

/**
 * sendDiscord(event, payload) → void
 * payload: { url?, status?, sha?, reason?, budget?, details? } — 외부사실만
 */
export async function sendDiscord(event, payload = {}) {
  const embed = buildEmbed(event, payload);
  const entry = {
    channel:  'discord',
    event,
    payload,
    embed,
    sent_at:  new Date().toISOString(),
    mock:     isMock(),
  };

  // 운영 경보(NOTIFY_FORCE_LIVE=1)는 mock 게이트를 넘는다 — 근거는 live-override.mjs.
  if (isMock() && !forceLive()) {
    console.log(`[notify/discord] MOCK ${event}:`, JSON.stringify(embed, null, 2));
    writeMockLog(entry);
    return { delivery: 'mock' };
  }

  const webhookUrl = env('DISCORD_WEBHOOK_URL');

  if (!webhookUrl) {
    console.warn('[notify/discord] DISCORD_WEBHOOK_URL 없음 — 콘솔 출력으로 대체');
    console.log(JSON.stringify(embed, null, 2));
    writeMockLog({ ...entry, mock: true, reason: 'no_credentials' });
    // 'sent' 이 아니라고 분명히 말한다 — 안 보냈는데 ok 로 보고하면 다음 검증이 자기확인이 된다.
    return { delivery: 'console-fallback' };
  }

  await postWebhook(webhookUrl, embed);
  console.log(`[notify/discord] 전송 완료: ${event}`);
  return { delivery: 'sent' };
}
