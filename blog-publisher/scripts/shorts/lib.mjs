/**
 * shorts/lib.mjs — 블로그 글 → 유튜브 쇼츠 공용 유틸
 *
 * 경로·설정·인덱스 I/O·벤더 바이너리(ffmpeg)·상태 큐를 한곳에 모은다.
 * published/ 파서·frontmatter 파서는 lib/published-doc.mjs 를 재사용한다.
 *
 * 테스트 격리: STATE_DIR_OVERRIDE, PUBLISHED_DIR_OVERRIDE, SHORTS_CONFIG_OVERRIDE.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, appendFileSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { paths } from '../lib/config.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dir, '../../');

export function shortsConfigPath() {
  return process.env.SHORTS_CONFIG_OVERRIDE || join(REPO_ROOT, 'config', 'shorts.json');
}

export function loadShortsConfig() {
  const cfg = JSON.parse(readFileSync(shortsConfigPath(), 'utf8'));
  if (!cfg.tts || !cfg.video) throw new Error('shorts.json: tts/video 필수');
  return cfg;
}

/** ~ 를 홈으로 확장 */
export function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~') ? join(homedir(), p.slice(1).replace(/^[/\\]/, '')) : p;
}

/**
 * 벤더 정적 ffmpeg/ffprobe 우선(sudo 없는 WSL). 없으면 PATH 폴백.
 * (메모리 [[headless-browser-diagnosis]] 의 벤더-바이너리 철학과 동일.)
 */
export function ffmpegBin(name = 'ffmpeg') {
  const vendored = join(REPO_ROOT, 'vendor', 'ffmpeg-static', name);
  return existsSync(vendored) ? vendored : name;
}

export function queueRoot() {
  return join(paths.state, 'shorts-queue');
}

/** 슬러그별 작업 디렉토리 (중간산출: 슬라이드 png·오디오·mp4) */
export function workDir(slug) {
  return join(queueRoot(), 'work', slug);
}

export function pendingDir() {
  return join(queueRoot(), 'pending');
}

export function postedDir() {
  return join(queueRoot(), 'posted');
}

export function postedLogPath() {
  return join(queueRoot(), 'posted.jsonl');
}

export function indexPath() {
  return join(paths.state, 'shorts-index.json');
}

/**
 * shorts-index.json — per-slug 쇼츠 제작 상태의 단일 진실.
 * { <slug>: { selected_at, source_file, status: 'queued'|'uploaded',
 *   video_file?, queued_at, uploaded_at?, youtube_id?, youtube_url? } }
 */
export function loadIndex() {
  const p = indexPath();
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')) || {}; }
  catch { return {}; }
}

export function saveIndex(idx) {
  const p = indexPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(idx, null, 2) + '\n', 'utf8');
}

export function markQueued(slug, { sourceFile, videoFile }) {
  const idx = loadIndex();
  idx[slug] = {
    ...(idx[slug] || {}),
    source_file: sourceFile,
    video_file: videoFile,
    status: 'queued',
    queued_at: new Date().toISOString(),
    selected_at: idx[slug]?.selected_at || new Date().toISOString(),
  };
  saveIndex(idx);
  return idx[slug];
}

/** pending → posted 전이 + 인덱스 갱신 (업로드 성공 후). */
export function markUploaded(slug, { youtubeId, youtubeUrl, pendingFile }) {
  if (pendingFile && existsSync(join(pendingDir(), pendingFile))) {
    mkdirSync(postedDir(), { recursive: true });
    renameSync(join(pendingDir(), pendingFile), join(postedDir(), basename(pendingFile)));
  }
  const rec = { ts: new Date().toISOString(), slug, youtube_id: youtubeId, youtube_url: youtubeUrl };
  mkdirSync(queueRoot(), { recursive: true });
  appendFileSync(postedLogPath(), JSON.stringify(rec) + '\n', 'utf8');
  const idx = loadIndex();
  idx[slug] = {
    ...(idx[slug] || {}),
    status: 'uploaded', uploaded_at: rec.ts, youtube_id: youtubeId, youtube_url: youtubeUrl,
  };
  saveIndex(idx);
  return rec;
}

export function ensureDirs() {
  for (const d of [queueRoot(), pendingDir(), postedDir()]) mkdirSync(d, { recursive: true });
}

/** mp3/영상 길이(초)를 ffprobe 로 측정. 실패 시 null(호출자가 명확히 처리). */
export function probeDurationSec(file) {
  try {
    const out = execFileSync(ffmpegBin('ffprobe'), [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file,
    ], { encoding: 'utf8' });
    const d = parseFloat(out.trim());
    return Number.isFinite(d) ? d : null;
  } catch { return null; }
}

/**
 * 영상 앞부분 무음 길이(초) 측정 — ffmpeg silencedetect. 0초부터 시작하는
 * 무음 구간의 끝(silence_end)이 곧 선두 무음 길이. 무음 없으면 0.
 */
export function measureLeadingSilence(file) {
  // ffmpeg 는 -f null 로 정상 종료(exit 0)하며 로그를 stderr 로 낸다. execFileSync 는 stdout 만
  // 반환하므로 성공 시 stderr 를 못 얻는다 → spawnSync 로 종료코드와 무관하게 stderr 확보.
  const res = spawnSync(ffmpegBin('ffmpeg'), [
    '-hide_banner', '-i', file, '-af', 'silencedetect=noise=-45dB:d=0.3', '-f', 'null', '-',
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const stderr = String(res.stderr || '');
  const starts = [...stderr.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map(m => parseFloat(m[1]));
  const ends = [...stderr.matchAll(/silence_end:\s*([\d.]+)/g)].map(m => parseFloat(m[1]));
  if (starts.length && starts[0] <= 0.05 && ends.length) return ends[0]; // 0초에서 시작하는 무음
  return 0;
}

/**
 * 영상 모션 점수(슬라이드쇼-리스크 게이트용). 인접 프레임 차분(tblend difference)의
 * 평균 휘도(YAVG)를 4fps 샘플로 측정 → 값이 높을수록 실제 움직임 多. 정적 슬라이드쇼는 ~0.
 * @returns {number} 평균 프레임차 휘도(대략 0~40). 측정 실패 시 -1.
 */
export function measureMotionScore(file) {
  const res = spawnSync(ffmpegBin('ffmpeg'), [
    '-hide_banner', '-i', file,
    '-vf', 'fps=4,scale=240:426,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG',
    '-f', 'null', '-',
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const stderr = String(res.stderr || '');
  // 첫 프레임은 이전 프레임이 없어 YAVG 가 비정상적으로 큼 → 제외하고 평균.
  const vals = [...stderr.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map(m => parseFloat(m[1])).filter(Number.isFinite);
  if (vals.length <= 1) return vals.length ? vals[0] : -1;
  const body = vals.slice(1);
  return body.reduce((a, b) => a + b, 0) / body.length;
}

// 정본은 lib/main-module.mjs 한 곳이다. 기존 소비자를 위해 여기서 재export 한다.
export { isMainModule } from '../lib/main-module.mjs';
