/**
 * shorts/assemble.mjs — 배경(AI이미지/그라데이션) + 투명 텍스트 오버레이 + 더빙 → 9:16 mp4
 *
 * 세그먼트 전략(견고성 우선): 카드마다 [배경 켄번스 줌] 위에 [투명 텍스트 오버레이]를
 * 얹고 해당 narration 오디오를 붙여 세그먼트 mp4 생성 → concat 데먹서로 이어붙임.
 * 배경엔 모션, 글자는 또렷. 자막=오버레이 caption(더빙과 1:1 → 자동 싱크). BGM 옵션.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ffmpegBin, workDir, expandHome, REPO_ROOT, probeDurationSec } from './lib.mjs';
import { groupTimings } from './captions.mjs';

function ff(args) {
  return execFileSync(ffmpegBin('ffmpeg'), ['-y', '-hide_banner', '-loglevel', 'error', ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * 세그먼트: 배경 + 오버레이(정적/키네틱) + 오디오.
 * 배경이 video(실모션 푸티지)면 켄번스 없이 커버크롭 루프, image(AI/그라데이션)면 켄번스 줌.
 * overlays 가 배열이면 그룹별 시간창으로 순차 노출(키네틱 단어단위 자막).
 */
function buildSegment({ bg, overlays, audio, dur, audioDur, fps, out, padHead, motion, index }) {
  const isVideo = bg && bg.type === 'video';
  const bgFile = bg && bg.file ? bg.file : bg; // 하위호환(문자열=이미지)
  const ovList = Array.isArray(overlays) ? overlays : [overlays];
  const frames = Math.max(1, Math.round(dur * fps));

  // 입력: [0]=배경, [1..K]=오버레이 프레임(loop), [K+1]=오디오
  const inputs = [];
  if (isVideo) inputs.push('-stream_loop', '-1', '-i', bgFile);
  else inputs.push('-loop', '1', '-i', bgFile);
  for (const ov of ovList) inputs.push('-loop', '1', '-i', ov);
  inputs.push('-i', audio);
  const audioIdx = 1 + ovList.length;

  // 배경 체인
  let bgChain;
  if (isVideo) {
    bgChain = `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=${fps}[z]`;
  } else {
    const perFrame = (motion?.zoom_per_sec ?? 0.02) / fps;
    const maxZoom = motion?.max_zoom ?? 1.14;
    const kb = motion?.ken_burns !== false;
    const pans = [
      { x: 'iw/2-(iw/zoom/2)', y: 'ih/2-(ih/zoom/2)' },
      { x: 'iw/2-(iw/zoom/2)', y: '0' },
      { x: 'iw/2-(iw/zoom/2)', y: 'ih-(ih/zoom)' },
      { x: '0', y: 'ih/2-(ih/zoom/2)' },
      { x: 'iw-(iw/zoom)', y: 'ih/2-(ih/zoom/2)' },
    ];
    const pan = pans[index % pans.length];
    const cover = 'scale=2160:3840:force_original_aspect_ratio=increase,crop=2160:3840';
    bgChain = kb
      ? `[0:v]${cover},zoompan=z='min(zoom+${perFrame.toFixed(5)},${maxZoom})':d=${frames}:x='${pan.x}':y='${pan.y}':s=1080x1920:fps=${fps}[z]`
      : `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=${fps}[z]`;
  }

  // 오버레이 체인(키네틱=그룹별 시간창, 정적=풀타임)
  const timings = ovList.length > 1 ? groupTimings(ovList.length, dur, audioDur, padHead) : [{ start: 0, end: dur }];
  const parts = [bgChain];
  let cur = 'z';
  for (let k = 0; k < ovList.length; k++) {
    const outLabel = k === ovList.length - 1 ? 'cmp' : `o${k}`;
    const en = ovList.length > 1 ? `:enable='between(t,${timings[k].start},${timings[k].end})'` : '';
    parts.push(`[${cur}][${k + 1}:v]overlay=0:0:format=auto${en}[${outLabel}]`);
    cur = outLabel;
  }
  const fadeOut = Math.max(0, dur - 0.35).toFixed(2);
  parts.push(`[${cur}]fade=t=in:st=0:d=0.3,fade=t=out:st=${fadeOut}:d=0.35,format=yuv420p[v]`);
  const af = `adelay=${Math.round(padHead * 1000)}|${Math.round(padHead * 1000)},apad`;

  ff([
    ...inputs,
    '-filter_complex', parts.join(';'),
    '-filter:a', af,
    '-map', '[v]', '-map', `${audioIdx}:a`,
    '-t', dur.toFixed(2),
    '-c:v', 'libx264', '-preset', 'medium', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
    out,
  ]);
  return out;
}

/**
 * @param backgrounds (string|{type:'video'|'image',file})[] 배경 (slideList 순). 문자열=이미지 PNG.
 * @param overlays    (string|string[])[] 오버레이 PNG. 배열이면 키네틱 그룹 프레임.
 * @param audio       {file,durationSec}[] (slideList 순)
 * @returns { videoFile }
 */
export async function assemble(script, { backgrounds, overlays, audio, cfg }) {
  const v = cfg.video || {};
  const motion = cfg.motion || {};
  const fps = v.fps || 30;
  const padHead = v.pad_head_sec ?? 0.3;
  const padTail = v.pad_tail_sec ?? 0.6;
  const n = overlays.length;
  if (backgrounds.length !== n || audio.length !== n) {
    throw new Error(`배경(${backgrounds.length})·오버레이(${n})·오디오(${audio.length}) 개수 불일치`);
  }
  const dir = workDir(script.slug);
  const segDir = join(dir, 'seg');
  if (existsSync(segDir)) rmSync(segDir, { recursive: true, force: true });
  mkdirSync(segDir, { recursive: true });

  const segFiles = [];
  for (let i = 0; i < n; i++) {
    let aDur = Number.isFinite(audio[i]?.durationSec) ? audio[i].durationSec : probeDurationSec(audio[i].file);
    if (!Number.isFinite(aDur) || aDur <= 0) throw new Error(`오디오 길이 측정 실패: ${audio[i]?.file}`);
    const dur = padHead + aDur + (i === n - 1 ? padTail : 0.3);
    const out = join(segDir, `seg-${String(i).padStart(2, '0')}.mp4`);
    // 배경 정규화: 문자열=이미지, {type,file}=그대로
    const bg = typeof backgrounds[i] === 'string' ? { type: 'image', file: backgrounds[i] } : backgrounds[i];
    buildSegment({ bg, overlays: overlays[i], audio: audio[i].file, dur, audioDur: aDur, fps, out, padHead, motion, index: i });
    segFiles.push(out);
  }

  const listFile = join(segDir, 'concat.txt');
  writeFileSync(listFile, segFiles.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n', 'utf8');
  const concatOut = join(dir, `${script.slug}.mp4`);

  const bgm = v.bgm || {};
  const bgmFile = bgm.enabled ? expandHome(join(REPO_ROOT, bgm.file || '')) : null;
  if (bgmFile && existsSync(bgmFile)) {
    const merged = join(dir, `${script.slug}.nobgm.mp4`);
    ff(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', merged]);
    ff([
      '-i', merged, '-stream_loop', '-1', '-i', bgmFile,
      '-filter_complex', `[1:a]volume=${bgm.volume ?? 0.12}[bg];[0:a][bg]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[a]`,
      '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', concatOut,
    ]);
    rmSync(merged, { force: true });
  } else {
    ff(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', concatOut]);
  }

  // 전역 재생 속도(예: 1.3배). setpts(영상)+atempo(음성, 피치 보존). speed<=1 이면 스킵.
  const speed = v.speed || 1;
  if (speed && speed !== 1) {
    const spedOut = join(dir, `${script.slug}.speed.mp4`);
    ff([
      '-i', concatOut,
      '-filter_complex', `[0:v]setpts=PTS/${speed}[v];[0:a]atempo=${speed}[a]`,
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-r', String(fps),
      '-c:a', 'aac', '-b:a', '160k', spedOut,
    ]);
    rmSync(concatOut, { force: true });
    return { videoFile: spedOut };
  }
  return { videoFile: concatOut };
}
