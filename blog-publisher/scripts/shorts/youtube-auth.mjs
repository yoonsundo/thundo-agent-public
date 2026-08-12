#!/usr/bin/env node
/**
 * shorts/youtube-auth.mjs — YouTube 업로드용 1회 OAuth (refresh token 발급)
 *
 * 서비스계정으론 개인 채널 업로드 불가 → 채널 소유 Google 계정의 OAuth2 로 refresh token 을
 * 1회 발급받아 저장한다. loopback 방식(127.0.0.1) — 데스크톱 OAuth 클라이언트 표준.
 *
 * 준비(콘솔, 1회):
 *   1) YouTube Data API v3 사용설정: gcloud services enable youtube.googleapis.com --project=<pid>
 *   2) OAuth 동의화면 구성(외부, 테스트 사용자에 본인 gmail 추가) — 게시 안 해도 테스트 사용자는 됨
 *   3) 사용자 인증 정보 → OAuth 클라이언트 ID → 유형 "데스크톱 앱" → client_secret_*.json 다운로드
 *
 * 사용(본인 터미널에서 — 브라우저 열려야 함):
 *   node scripts/shorts/youtube-auth.mjs --client <client_secret_*.json 경로> --channel curiosity
 *   node scripts/shorts/youtube-auth.mjs --client <경로> --channel blog
 *   (또는 --out <토큰 저장 경로> 직접 지정)
 *
 * 저장: {client_id, client_secret, refresh_token} → ~/.secrets/youtube-<channel>-oauth.json
 * 이후 config.upload.enabled=true 로 바꾸면 무인 업로드 가동.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const SCOPE = 'https://www.googleapis.com/auth/youtube.upload';

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : def;
}
function expandHome(p) { return p && p.startsWith('~') ? join(homedir(), p.slice(1).replace(/^[/\\]/, '')) : p; }

function loadClient(clientPath) {
  const raw = JSON.parse(readFileSync(resolve(clientPath), 'utf8'));
  const c = raw.installed || raw.web || raw;
  if (!c.client_id || !c.client_secret) throw new Error('client_secret json 에 client_id/client_secret 없음');
  return { client_id: c.client_id, client_secret: c.client_secret };
}

async function main() {
  const clientPath = arg('--client');
  if (!clientPath) { console.error('필수: --client <client_secret_*.json 경로>'); process.exit(2); }
  const channel = arg('--channel', 'blog');
  const out = expandHome(arg('--out', join(homedir(), '.secrets', `youtube-${channel}-oauth.json`)));
  const { client_id, client_secret } = loadClient(clientPath);
  const port = parseInt(arg('--port', '8723'), 10);
  const redirect = `http://127.0.0.1:${port}`;

  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id, redirect_uri: redirect, response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent',
  }).toString();

  console.log('\n브라우저에서 아래 URL 을 열어 채널 소유 계정으로 인증하세요:\n');
  console.log(authUrl + '\n');
  console.log(`(인증 후 ${redirect} 로 리다이렉트됩니다 — 이 창은 자동으로 코드를 받습니다)\n`);

  const code = await new Promise((res, rej) => {
    const server = createServer((req, resp) => {
      const u = new URL(req.url, redirect);
      const c = u.searchParams.get('code');
      const err = u.searchParams.get('error');
      resp.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      resp.end(`<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>${c ? '인증 완료 ✅ 터미널로 돌아가세요' : '인증 실패: ' + (err || 'no code')}</h2></body></html>`);
      server.close();
      c ? res(c) : rej(new Error(err || 'no code'));
    });
    server.on('error', rej);
    server.listen(port, '127.0.0.1');
    setTimeout(() => { server.close(); rej(new Error('5분 타임아웃')); }, 300_000);
  });

  const tokRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id, client_secret, redirect_uri: redirect, grant_type: 'authorization_code' }),
  });
  const tok = await tokRes.json();
  if (!tok.refresh_token) {
    console.error('refresh_token 미발급. 응답:', JSON.stringify(tok).slice(0, 300));
    console.error('→ prompt=consent 로 재시도하거나, 계정의 앱 액세스 권한을 해제 후 재인증하세요.');
    process.exit(1);
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ client_id, client_secret, refresh_token: tok.refresh_token }, null, 2) + '\n', { mode: 0o600 });
  console.log(`\n✅ refresh token 저장: ${out}`);
  console.log(`이제 config 의 upload.enabled=true 로 바꾸면 ${channel} 채널 무인 업로드가 가동됩니다.`);
}

main().catch(e => { console.error('오류:', e.message); process.exit(2); });
