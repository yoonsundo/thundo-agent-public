/**
 * notify/send-report.mjs — Parrot 브리핑 네이티브 포맷 전송.
 * 채팅앱은 마크다운 표를 렌더 못 하므로 각 앱 네이티브 리치 포맷으로 "메시지 본문"에 보낸다.
 * (첨부 파일 없음 → Telegram 한글깨짐·Slack files:write 스코프 문제 원천 제거)
 *   - Slack   : chat.postMessage(blocks)       [SALES_SLACK_BOT_TOKEN/CHANNEL_ID]
 *   - Discord : webhook(embeds)                [DISCORD_WEBHOOK_URL]
 *   - Telegram: sendMessage(HTML, 청크)        [TELEGRAM_BOT_TOKEN/CHAT_ID]
 * 크리덴셜 없으면 그 채널만 스킵. 비밀은 로그에 찍지 않는다.
 */
import { env } from '../lib/config.mjs';

const TIMEOUT = 20_000;

// ── Slack (Block Kit) ────────────────────────────────────────────────────────
async function sendSlack(slack) {
  if (!slack || !slack.text) return { channel: 'slack', status: 'skip', reason: 'no_payload' };
  const token = env('SALES_SLACK_BOT_TOKEN');
  const channel = env('SALES_SLACK_CHANNEL_ID');
  if (!token || !channel) return { channel: 'slack', status: 'skip', reason: 'no_credentials' };
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
    // unfurl_*: false — 본문 속 URL(예: 사이트 응답 체크의 thundo.kr)이 링크 미리보기 카드로 붙는 것 차단
    body: JSON.stringify({ channel, text: slack.text, blocks: slack.blocks, unfurl_links: false, unfurl_media: false }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`chat.postMessage: ${j.error}`);
  return { channel: 'slack', status: 'ok' };
}

// ── Discord (Embed) ──────────────────────────────────────────────────────────
async function sendDiscord(discord) {
  if (!discord || !discord.embeds) return { channel: 'discord', status: 'skip', reason: 'no_payload' };
  const url = env('DISCORD_WEBHOOK_URL');
  if (!url) return { channel: 'discord', status: 'skip', reason: 'no_credentials' };
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ embeds: discord.embeds }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok && res.status !== 204) throw new Error(`discord ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { channel: 'discord', status: 'ok' };
}

// ── Telegram (HTML, 청크) ────────────────────────────────────────────────────
async function sendTelegram(chunks) {
  const token = env('TELEGRAM_BOT_TOKEN');
  const chatId = env('TELEGRAM_CHAT_ID');
  if (!token || !chatId) return { channel: 'telegram', status: 'skip', reason: 'no_credentials' };
  for (const part of chunks) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: part, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) throw new Error(`sendMessage ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return { channel: 'telegram', status: 'ok' };
}

/**
 * sendReport({ slack, discord, telegram }) → 채널별 결과 배열.
 *   slack: {text, blocks} · discord: {embeds} · telegram: [html chunks]
 * 세 채널 병렬, 한쪽 실패해도 계속.
 */
export async function sendReport({ slack, discord, telegram }) {
  const tasks = [
    sendSlack(slack).catch(e => ({ channel: 'slack', status: 'error', reason: String(e.message || e) })),
    sendDiscord(discord).catch(e => ({ channel: 'discord', status: 'error', reason: String(e.message || e) })),
    sendTelegram(telegram).catch(e => ({ channel: 'telegram', status: 'error', reason: String(e.message || e) })),
  ];
  return Promise.all(tasks);
}
