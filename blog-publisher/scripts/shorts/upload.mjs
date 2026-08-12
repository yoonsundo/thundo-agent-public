/**
 * shorts/upload.mjs — YouTube 업로드 (staged)
 *
 * ⚠ v1 미가동: 채널 미생성 + OAuth 미설정 → config upload.enabled=false 면 no-op.
 * 서비스계정으론 개인채널 업로드 불가 → 1회 OAuth(youtube.upload 스코프)로 얻은
 * refresh token(oauth_token_file, {client_id,client_secret,refresh_token})이 있어야
 * 무인 업로드가 가능하다. 준비되면 config upload.enabled=true.
 *
 * 여기서는 자격/설정을 검증하고, 없으면 명확한 skip 사유를 반환한다(파괴적 동작 없음).
 */
import { readFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import { expandHome } from './lib.mjs';

/** 업로드 가능 여부 사전 점검(파괴적 동작 없음). */
export function uploadReadiness(cfg) {
  const u = cfg.upload || {};
  if (!u.enabled) return { ready: false, reason: 'upload.enabled=false (채널 준비 전 — staged)' };
  const tokenFile = expandHome(u.oauth_token_file || '');
  if (!tokenFile || !existsSync(tokenFile)) return { ready: false, reason: `OAuth 토큰 파일 없음: ${tokenFile}` };
  let tok;
  try { tok = JSON.parse(readFileSync(tokenFile, 'utf8')); } catch { return { ready: false, reason: 'OAuth 토큰 파일 파싱 실패' }; }
  for (const k of ['client_id', 'client_secret', 'refresh_token']) {
    if (!tok[k]) return { ready: false, reason: `OAuth 토큰에 ${k} 없음` };
  }
  return { ready: true, token: tok, tokenFile };
}

/** refresh token → access token. */
async function accessToken(tok) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: tok.client_id, client_secret: tok.client_secret,
      refresh_token: tok.refresh_token, grant_type: 'refresh_token',
    }),
  });
  if (res.status !== 200) throw new Error(`토큰 갱신 실패 HTTP ${res.status}`);
  const j = await res.json();
  if (!j.access_token) throw new Error('access_token 부재');
  return j.access_token;
}

/**
 * 영상 업로드. metadata: {title, description, tags[]}.
 * @returns {Promise<{ok, youtubeId?, youtubeUrl?, skipped?, reason?}>}
 */
export async function uploadVideo(videoFile, metadata, cfg) {
  const r = uploadReadiness(cfg);
  if (!r.ready) return { ok: false, skipped: true, reason: r.reason };
  if (!existsSync(videoFile)) return { ok: false, reason: `영상 파일 없음: ${videoFile}` };
  const u = cfg.upload || {};
  const token = await accessToken(r.token);

  const meta = {
    snippet: {
      title: (metadata.title || '').slice(0, 100),
      description: metadata.description || '',
      tags: (metadata.tags || []).slice(0, 15),
      categoryId: u.category_id || '28',
    },
    status: {
      privacyStatus: u.privacy_status || 'private',
      selfDeclaredMadeForKids: !!u.made_for_kids,
    },
  };

  // resumable 업로드 세션 시작
  const size = statSync(videoFile).size;
  const initRes = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(size), 'X-Upload-Content-Type': 'video/*',
      },
      body: JSON.stringify(meta),
    });
  if (initRes.status !== 200) return { ok: false, reason: `업로드 세션 시작 실패 HTTP ${initRes.status}` };
  const uploadUrl = initRes.headers.get('location');
  if (!uploadUrl) return { ok: false, reason: 'upload location 헤더 없음' };

  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/*', 'Content-Length': String(size) },
    body: createReadStream(videoFile),
    duplex: 'half',
  });
  if (putRes.status !== 200 && putRes.status !== 201) {
    return { ok: false, reason: `업로드 실패 HTTP ${putRes.status}` };
  }
  const j = await putRes.json();
  const id = j.id;
  return { ok: true, youtubeId: id, youtubeUrl: id ? `https://youtube.com/shorts/${id}` : null };
}
