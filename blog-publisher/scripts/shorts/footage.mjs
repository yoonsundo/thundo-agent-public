/**
 * shorts/footage.mjs — 무료 실모션 스톡 푸티지 (Pexels 우선 → Pixabay 폴백)
 *
 * "켄번스+정지이미지 슬라이드쇼" 탈피의 핵심. 카드 대본의 **영어 키워드**로 세로(9:16)
 * 실모션 클립을 검색·다운로드해 배경으로 쓴다(한국어 쿼리는 스톡에 결과 없음 — 레퍼런스 근거).
 *
 * 키: .env 의 PEXELS_API_KEY / PIXABAY_API_KEY (스크립트는 .env 자동로드 안 하므로 자체 파서).
 * 무키/실패 시 {ok:false} → 호출자(produce)가 AI 이미지 → 그라데이션으로 폴백(런 안 죽음).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, ffmpegBin } from './lib.mjs';
import { execFileSync } from 'node:child_process';

/** process.env 우선, 없으면 REPO_ROOT/.env 파싱(캐시). git 제외 파일. */
let _envCache = null;
function envKey(name) {
  if (process.env[name]) return process.env[name];
  if (_envCache === null) {
    _envCache = {};
    try {
      const raw = readFileSync(join(REPO_ROOT, '.env'), 'utf8');
      for (const line of raw.split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m) _envCache[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    } catch { /* .env 없음 — 무키로 처리 */ }
  }
  return _envCache[name] || null;
}

export function footageEnabled(cfg) {
  return !!(cfg?.footage && cfg.footage.enabled);
}

function cacheDir(cfg) {
  const d = join(REPO_ROOT, cfg?.footage?.cache_dir || 'state/shorts-footage');
  mkdirSync(d, { recursive: true });
  return d;
}

/** Pexels 세로 영상 검색 → 최적 클립 {link,width,height,duration} 또는 null. */
async function searchPexels(query, cfg) {
  const key = envKey('PEXELS_API_KEY');
  if (!key) return { skip: 'PEXELS_API_KEY 없음' };
  const size = cfg?.footage?.size || 'medium';
  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&orientation=portrait&size=${size}&per_page=8`;
  let j;
  try {
    const r = await fetch(url, { headers: { Authorization: key } });
    if (r.status !== 200) return { error: `pexels HTTP ${r.status}` };
    j = await r.json();
  } catch (e) { return { error: `pexels 네트워크: ${e.message}` }; }
  const minDur = cfg?.footage?.min_duration_sec ?? 3;
  const vids = (j.videos || []).filter(v => (v.duration || 0) >= minDur);
  for (const v of vids) {
    // 세로 우선, 1080 근처 해상도 파일 선택
    const files = (v.video_files || [])
      .filter(f => f.height >= f.width && f.link)
      .sort((a, b) => Math.abs((a.height || 0) - 1920) - Math.abs((b.height || 0) - 1920));
    const pick = files[0];
    if (pick) return { link: pick.link, width: pick.width, height: pick.height, duration: v.duration, source: 'pexels', credit: v.user?.name };
  }
  return { none: true };
}

/** Pixabay 영상 검색(가로 위주 → 커버크롭 보조). */
async function searchPixabay(query, cfg) {
  const key = envKey('PIXABAY_API_KEY');
  if (!key) return { skip: 'PIXABAY_API_KEY 없음' };
  const url = `https://pixabay.com/api/videos/?key=${key}&q=${encodeURIComponent(query)}&per_page=8&safesearch=true`;
  let j;
  try {
    const r = await fetch(url);
    if (r.status !== 200) return { error: `pixabay HTTP ${r.status}` };
    j = await r.json();
  } catch (e) { return { error: `pixabay 네트워크: ${e.message}` }; }
  const minDur = cfg?.footage?.min_duration_sec ?? 3;
  const hit = (j.hits || []).find(h => (h.duration || 0) >= minDur && (h.videos?.large?.url || h.videos?.medium?.url));
  if (!hit) return { none: true };
  const v = hit.videos.large?.url ? hit.videos.large : hit.videos.medium;
  return { link: v.url, width: v.width, height: v.height, duration: hit.duration, source: 'pixabay', credit: hit.user };
}

/**
 * 영어 키워드로 실모션 클립 1개 확보 → 로컬 mp4 경로.
 * @returns {Promise<{ok:boolean, file?:string, meta?:object, error?:string}>}
 */
export async function fetchFootage(query, outBase, cfg) {
  if (!footageEnabled(cfg)) return { ok: false, error: 'footage 비활성' };
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: '빈 키워드' };
  const order = cfg.footage.provider_order || ['pexels', 'pixabay'];
  const searchers = { pexels: searchPexels, pixabay: searchPixabay };

  let meta = null, notes = [];
  for (const p of order) {
    const fn = searchers[p];
    if (!fn) continue;
    const r = await fn(q, cfg);
    if (r.link) { meta = r; break; }
    notes.push(`${p}:${r.skip || r.error || (r.none ? 'no-match' : '?')}`);
  }
  if (!meta) return { ok: false, error: `클립 없음 (${notes.join(', ')})` };

  const out = `${outBase}.mp4`;
  try {
    const res = await fetch(meta.link);
    if (!res.ok) return { ok: false, error: `다운로드 HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    mkdirSync(join(out, '..'), { recursive: true });
    writeFileSync(out, buf);
  } catch (e) { return { ok: false, error: `다운로드 실패: ${e.message}` }; }

  // 유효성: ffprobe 로 영상 스트림 확인
  try {
    execFileSync(ffmpegBin('ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', out], { encoding: 'utf8' });
  } catch { return { ok: false, error: '다운로드 파일 손상' }; }

  return { ok: true, file: out, meta };
}

export { cacheDir };
