#!/usr/bin/env node
/**
 * shorts/gates.mjs — 쇼츠 영상 결정론 게이트 (ffprobe 기반)
 *
 * 사용: node scripts/shorts/gates.mjs <video.mp4>
 * 검사: 9:16 해상도 · 길이 15~62초 · 오디오 존재 · 파일크기 · (앞부분 무음 과다 X)
 * 계약: stdout JSON 1줄 {ok, checks[], video}. exit 0=통과 / 1=실패 / 2=실행오류
 * (블로그 15종 게이트 exit 계약과 동일.)
 */
import { statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { makeLogger } from '../lib/log.mjs';
import { ffmpegBin, loadShortsConfig, measureLeadingSilence, measureMotionScore, isMainModule } from './lib.mjs';

const log = makeLogger('shorts/gates');

function probe(file) {
  const out = execFileSync(ffmpegBin('ffprobe'), [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(out);
}

/** 순수 판정 — probe 결과 + 파일크기(MB) → {ok, checks}. */
export function judge(meta, sizeMb, g) {
  const vs = (meta.streams || []).find(s => s.codec_type === 'video') || {};
  const as = (meta.streams || []).find(s => s.codec_type === 'audio');
  const dur = parseFloat(meta.format?.duration || '0');
  const w = vs.width || 0, h = vs.height || 0;
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass, detail });

  add('aspect', w === (g.aspect_w ?? 1080) && h === (g.aspect_h ?? 1920), `${w}x${h}`);
  add('duration', dur >= (g.min_sec ?? 15) && dur <= (g.max_sec ?? 62), `${dur.toFixed(1)}s`);
  add('audio', g.require_audio ? !!as : true, as ? `${as.codec_name}` : '오디오 없음');
  add('filesize', sizeMb <= (g.max_mb ?? 100), `${sizeMb.toFixed(1)}MB`);

  return { ok: checks.every(c => c.pass), checks };
}

export function runGate(video, cfg) {
  cfg = cfg || loadShortsConfig();
  const g = cfg.gates || {};
  const meta = probe(video);
  const sizeMb = statSync(video).size / (1024 * 1024);
  const result = judge(meta, sizeMb, g);
  // 선두 무음 과다 검사(리뷰 #5: config max_leading_silence_sec 실제 구동).
  if (g.max_leading_silence_sec != null) {
    const lead = measureLeadingSilence(video);
    const pass = lead <= g.max_leading_silence_sec;
    result.checks.push({ name: 'leading_silence', pass, detail: `${lead.toFixed(2)}s` });
    result.ok = result.ok && pass;
  }
  // 슬라이드쇼-리스크: 실제 모션이 최소치 미만이면 "애니메이티드 PPT" 로 판정(OpenMontage식).
  const sr = g.slideshow_risk || {};
  if (sr.enabled) {
    const score = measureMotionScore(video);
    const min = sr.min_motion_score ?? 1.0;
    // 측정 실패(-1)는 게이트를 막지 않음(정보 부족 시 통과).
    const pass = score < 0 ? true : score >= min;
    result.checks.push({ name: 'slideshow_risk', pass, detail: score < 0 ? '측정불가(skip)' : `motion=${score.toFixed(2)} (min ${min})` });
    result.ok = result.ok && pass;
  }
  return result;
}

function main() {
  const video = process.argv[2];
  if (!video) { log.error('사용법: shorts/gates.mjs <video.mp4>'); process.exit(2); }
  let result;
  try { result = runGate(resolve(video)); }
  catch (e) { log.error(`게이트 실행 오류: ${e.message}`); process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + '\n'); process.exit(2); }
  process.stdout.write(JSON.stringify({ ok: result.ok, checks: result.checks, video }) + '\n');
  for (const c of result.checks) log[c.pass ? 'info' : 'warn'](`${c.pass ? 'PASS' : 'FAIL'} ${c.name}: ${c.detail}`);
  process.exit(result.ok ? 0 : 1);
}

if (isMainModule(import.meta.url)) main();
