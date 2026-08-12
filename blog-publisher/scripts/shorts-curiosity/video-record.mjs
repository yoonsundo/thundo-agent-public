/**
 * shorts-curiosity/video-record.mjs — 업로드된 영상을 사이트 DB(youtube_videos)에 기록.
 *
 * 홈페이지 /videos 탭이 이 테이블을 읽어 유튜브 임베드로 스트리밍한다. 발행 성공마다 한 행
 * upsert → 신규 발행분이 홈페이지에 자동 반영(수동 개입·재배포 불필요).
 *
 * Supabase REST(PostgREST) upsert. 크리덴셜은 process.env(cron 은 --env-file=.env 주입).
 * 실패해도 업로드 흐름을 막지 않는다(경고만 — 발행 자체는 이미 성공).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../shorts/lib.mjs';
import { makeLogger } from '../lib/log.mjs';

const log = makeLogger('curiosity/video-record');

let _env = null;
function envVar(name) {
  if (process.env[name]) return process.env[name];
  if (_env === null) {
    _env = {};
    try {
      for (const line of readFileSync(join(REPO_ROOT, '.env'), 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m) _env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    } catch { /* .env 없음 */ }
  }
  return _env[name] || null;
}

/** 유튜브 영상 1건을 youtube_videos 에 upsert. @returns {Promise<{ok:boolean, error?:string}>} */
export async function recordUploadedVideo({ youtubeId, youtubeUrl, subject, title, domain }) {
  const url = envVar('SUPABASE_URL');
  const key = envVar('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return { ok: false, error: 'Supabase 크리덴셜 없음' };
  if (!youtubeId) return { ok: false, error: 'youtubeId 없음' };
  const row = {
    youtube_id: youtubeId,
    title: title || subject || '',
    subject: subject || '',
    domain: domain || '',
    youtube_url: youtubeUrl || `https://youtube.com/shorts/${youtubeId}`,
    thumbnail_url: `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`,
  };
  try {
    const res = await fetch(`${url}/rest/v1/youtube_videos`, {
      method: 'POST',
      headers: {
        apikey: key, Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(row),
    });
    if (res.status >= 300) return { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 150)}` };
    log.info(`영상 DB 기록: ${youtubeId} (${subject})`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `네트워크: ${e.message}` };
  }
}
