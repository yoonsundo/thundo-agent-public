/**
 * notify/send-file.mjs — 리포트 **파일 자체**를 첨부로 전송(Slack·Telegram).
 * send-report.mjs 는 의도적으로 인라인 텍스트만 보낸다(첨부 없음). 여기선 사용자가 요구한
 * "슬랙·텔레그램으로 파일 전송"을 위해 실제 문서 업로드를 담당한다. 요약은 send-report,
 * 원문 .md 첨부는 send-file — 둘을 함께 쓴다.
 *
 *   - Slack   : files.getUploadURLExternal → PUT 업로드 → files.completeUpload(채널)
 *               [SALES_SLACK_BOT_TOKEN + files:write 스코프 / SALES_SLACK_CHANNEL_ID]
 *   - Telegram: sendDocument(multipart)   [TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID]
 * 크리덴셜/스코프 없으면 그 채널만 skip. mock·SPIDER_DRY 면 .mock-out/notify.log 에만 기록.
 * 비밀은 로그에 찍지 않는다.
 */
import { readFileSync, mkdirSync, appendFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { env, paths } from '../lib/config.mjs';

const TIMEOUT = 30_000;

function mockLog(entry) {
  mkdirSync(paths.mockOut, { recursive: true });
  appendFileSync(join(paths.mockOut, 'notify.log'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8');
}

// ── Slack: 외부 업로드 3단계 ─────────────────────────────────────────────────
async function slackFile({ path, title, comment }) {
  const token = env('SALES_SLACK_BOT_TOKEN');
  const channel = env('SALES_SLACK_CHANNEL_ID');
  if (!token || !channel) return { channel: 'slack', status: 'skip', reason: 'no_credentials' };

  const bytes = readFileSync(path);
  const filename = basename(path);
  const auth = { authorization: `Bearer ${token}` };

  // 1) 업로드 URL 발급
  const form = new URLSearchParams({ filename, length: String(bytes.length) });
  const g = await fetch('https://slack.com/api/files.getUploadURLExternal', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
    body: form, signal: AbortSignal.timeout(TIMEOUT),
  }).then(r => r.json());
  if (!g.ok) return { channel: 'slack', status: 'error', reason: `getUploadURL: ${g.error}` };

  // 2) 파일 바이트 업로드
  const up = await fetch(g.upload_url, { method: 'POST', body: bytes, signal: AbortSignal.timeout(TIMEOUT) });
  if (!up.ok) return { channel: 'slack', status: 'error', reason: `upload ${up.status}` };

  // 3) 업로드 완료 + 채널 게시
  const c = await fetch('https://slack.com/api/files.completeUpload', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ files: [{ id: g.file_id, title: title || filename }], channel_id: channel, initial_comment: comment || '' }),
    signal: AbortSignal.timeout(TIMEOUT),
  }).then(r => r.json());
  if (!c.ok) return { channel: 'slack', status: 'error', reason: `completeUpload: ${c.error}` };
  return { channel: 'slack', status: 'ok' };
}

// ── Telegram: sendDocument(multipart) ────────────────────────────────────────
async function telegramFile({ path, title, comment }) {
  const token = env('TELEGRAM_BOT_TOKEN');
  const chatId = env('TELEGRAM_CHAT_ID');
  if (!token || !chatId) return { channel: 'telegram', status: 'skip', reason: 'no_credentials' };

  const bytes = readFileSync(path);
  const filename = basename(path);
  const fd = new FormData();
  fd.append('chat_id', chatId);
  const caption = [title, comment].filter(Boolean).join('\n').slice(0, 1024);
  if (caption) fd.append('caption', caption);
  fd.append('document', new Blob([bytes], { type: 'text/markdown' }), filename);

  const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: 'POST', body: fd, signal: AbortSignal.timeout(TIMEOUT),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) return { channel: 'telegram', status: 'error', reason: `sendDocument: ${j.description || res.status}` };
  return { channel: 'telegram', status: 'ok' };
}

/**
 * sendFile({ path, title, comment, slack=true, telegram=true }) → 채널별 결과 배열.
 * 두 채널 병렬, 한쪽 실패해도 계속. mock·SPIDER_DRY 면 실제 전송 없이 로그만.
 */
export async function sendFile({ path, title, comment, slack = true, telegram = true }) {
  if (!path) throw new Error('sendFile: path 필요');
  const size = (() => { try { return statSync(path).size; } catch { return -1; } })();
  if (size < 0) throw new Error(`sendFile: 파일 없음 ${path}`);

  if (process.env.SPIDER_DRY) {
    mockLog({ kind: 'sendFile', path: basename(path), bytes: size, title, channels: { slack, telegram } });
    return [
      slack ? { channel: 'slack', status: 'mock' } : null,
      telegram ? { channel: 'telegram', status: 'mock' } : null,
    ].filter(Boolean);
  }

  const tasks = [];
  if (slack) tasks.push(slackFile({ path, title, comment }).catch(e => ({ channel: 'slack', status: 'error', reason: String(e.message || e) })));
  if (telegram) tasks.push(telegramFile({ path, title, comment }).catch(e => ({ channel: 'telegram', status: 'error', reason: String(e.message || e) })));
  return Promise.all(tasks);
}
