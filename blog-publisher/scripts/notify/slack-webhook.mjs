/**
 * notify/slack-webhook.mjs — Slack Incoming Webhook 발송.
 * ⚠️ Webhook 은 **파일 업로드 불가**(메시지 본문만). 그래서 Spider 는 명세서 .md 를
 * "첨부"가 아니라 **메시지 본문에 인라인**으로 실어 웹훅으로 보낸다.
 * (파일 첨부가 꼭 필요하면 bot token + files:write 로 send-file.mjs 의 slack 경로를 쓴다.)
 *
 * env: CRW_SLACK_WEBHOOK_URL (기본) 또는 인자로 다른 키 지정.
 * 크리덴셜 없으면 skip. SPIDER_DRY 면 .mock-out/notify.log 에만.
 */
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { env, paths } from '../lib/config.mjs';

const TIMEOUT = 20_000;

/** sendSlackWebhook({ text, blocks, webhookEnv='CRW_SLACK_WEBHOOK_URL' }) → 결과 */
export async function sendSlackWebhook({ text, blocks, webhookEnv = 'CRW_SLACK_WEBHOOK_URL' }) {
  const url = env(webhookEnv);
  if (!url) return { channel: 'slack-webhook', status: 'skip', reason: `no_credentials(${webhookEnv})` };
  if (process.env.SPIDER_DRY) {
    mkdirSync(paths.mockOut, { recursive: true });
    appendFileSync(join(paths.mockOut, 'notify.log'), JSON.stringify({ ts: new Date().toISOString(), kind: 'slackWebhook', env: webhookEnv, blocks: blocks?.length || 0 }) + '\n', 'utf8');
    return { channel: 'slack-webhook', status: 'mock' };
  }
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    // unfurl_*: false — 본문 속 URL 이 링크 미리보기 카드로 붙는 것 차단
    body: JSON.stringify({ text, blocks, unfurl_links: false, unfurl_media: false }), signal: AbortSignal.timeout(TIMEOUT),
  });
  const body = await res.text().catch(() => '');
  if (!res.ok || body.trim() !== 'ok') return { channel: 'slack-webhook', status: 'error', reason: `webhook ${res.status}: ${body.slice(0, 120)}` };
  return { channel: 'slack-webhook', status: 'ok' };
}
