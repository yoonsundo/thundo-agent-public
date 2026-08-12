/**
 * shorts/produce.mjs — script.json → 게이트 통과 mp4 (공용 제작 코어)
 *
 * run-shorts(블로그) 와 shorts-curiosity(호기심 채널)가 공유하는 제작 파이프라인.
 * 입력: script 객체(slug·hook·cards[caption/narration/image_prompt]·cta).
 * 단계: AI 배경 → 시각요소 렌더 → 더빙 → ffmpeg 조립(켄번스) → 게이트.
 * 출력: { ok, videoFile?, gate?, stage?, reason?, steps }.
 */
import { join } from 'node:path';
import { makeLogger } from '../lib/log.mjs';
import { workDir, probeDurationSec } from './lib.mjs';
import { slideList, renderVisuals } from './slides.mjs';
import { generateImage, imagenEnabled } from './imagen.mjs';
import { fetchFootage, footageEnabled, cacheDir } from './footage.mjs';
import { synthesize, activeProvider } from './tts/index.mjs';
import { assemble } from './assemble.mjs';
import { runGate } from './gates.mjs';

const log = makeLogger('shorts/produce');

/** 키워드(배열/문자열) → 스톡 검색 쿼리 문자열. 빈 값이면 null. */
function kwToQuery(kw) {
  if (Array.isArray(kw)) kw = kw.length ? kw[0] : null; // 대표 1개(스톡은 짧은 구문이 매칭 유리)
  const q = String(kw || '').trim();
  return q || null;
}

/** 슬라이드 index → 그 카드의 영어 푸티지 검색어(hook/cta 는 null). footage_keywords 우선, 없으면 image_prompt 폴백. */
function footageKeywordFor(script, slideMeta, i) {
  const s = slideMeta[i];
  if (s.kind !== 'card') return null;
  const card = script.cards[s.index - 1];
  return kwToQuery(card?.footage_keywords) || kwToQuery(card?.image_prompt) || null;
}

/** slideList 순서(hook, cards…, cta)와 1:1 narration 배열. */
export function narrationList(script) {
  const arr = [script.hook];
  for (const c of script.cards) arr.push(c.narration);
  if (script.cta) arr.push(script.cta);
  return arr;
}

export async function produceFromScript(script, { cfg }) {
  const slug = script.slug;
  const dir = workDir(slug);
  const steps = {};

  const slideMeta = slideList(script);
  const nSlides = slideMeta.length;
  const mode = cfg.visual?.mode || (footageEnabled(cfg) ? 'hybrid' : 'image');

  // 1) 실모션 푸티지 (하이브리드: 카드 슬라이드는 실영상, hook/cta 는 AI 히어로).
  const footageClips = new Array(nSlides).fill(null);
  if (footageEnabled(cfg) && mode !== 'image') {
    const fdir = cacheDir(cfg);
    const targets = slideMeta.map((s, i) => ({ i, kw: mode === 'footage' ? (footageKeywordFor(script, slideMeta, i) || (i === 0 ? kwToQuery(script.hook_footage_keywords) : null)) : footageKeywordFor(script, slideMeta, i) }))
      .filter(t => t.kw);
    log.info(`실모션 푸티지 검색… (${targets.length}개, 영어키워드)`);
    const fres = await Promise.all(targets.map(async t => {
      const r = await fetchFootage(t.kw, join(fdir, `${slug}-${String(t.i).padStart(2, '0')}`), cfg);
      return { i: t.i, r };
    }));
    let ok = 0;
    for (const { i, r } of fres) {
      if (r.ok) { footageClips[i] = r.file; ok++; }
      else log.warn(`푸티지 실패(#${i}): ${r.error} → AI/그라데이션 폴백`);
    }
    steps.footage = `${ok}/${targets.length}`;
  }

  // 2) AI 배경 — 푸티지 없는 슬라이드(히어로+폴백)만 생성해 비용 절약.
  const aiImages = new Array(nSlides).fill(null);
  if (imagenEnabled(cfg)) {
    const need = slideMeta.map((s, i) => ({ s, i })).filter(({ s, i }) => !footageClips[i] && s.image_prompt);
    if (need.length) {
      log.info(`AI 배경 생성… (${need.length}장, 푸티지 없는 슬라이드)`);
      const results = await Promise.all(need.map(async ({ s, i }) => {
        const out = join(dir, `ai-${String(i).padStart(2, '0')}.png`);
        const r = await generateImage(s.image_prompt, out, cfg);
        return { i, path: r.ok ? out : (log.warn(`이미지 실패(#${i}): ${r.error}`), null) };
      }));
      let ok = 0;
      results.forEach(({ i, path }) => { if (path) { aiImages[i] = path; ok++; } });
      steps.ai_images = `${ok}/${need.length}`;
    }
  }

  // 3) 시각요소(그라데이션 폴백 배경 + 투명/키네틱 오버레이)
  log.info('시각요소 렌더…');
  const { overlays, backgrounds } = await renderVisuals(script, { dir, aiImages, cfg });
  steps.slides = overlays.length;

  // 배경 합성: 푸티지(video) > AI/그라데이션(image)
  const bgSpec = backgrounds.map((bgPng, i) => footageClips[i] ? { type: 'video', file: footageClips[i] } : { type: 'image', file: bgPng });

  // 4) 더빙
  const narrations = narrationList(script);
  if (narrations.length !== overlays.length) return { ok: false, stage: 'align', reason: `narration≠slides`, steps };
  log.info(`더빙 합성… (provider=${activeProvider(cfg)}, ${narrations.length}세그먼트)`);
  const audio = [];
  for (let i = 0; i < narrations.length; i++) {
    const out = join(dir, `audio-${String(i).padStart(2, '0')}.mp3`);
    const r = await synthesize(narrations[i], out, cfg);
    if (!r.ok) return { ok: false, stage: 'tts', reason: `더빙 실패(#${i}): ${r.error}`, steps };
    const d = Number.isFinite(r.durationSec) ? r.durationSec : probeDurationSec(out);
    if (!Number.isFinite(d) || d <= 0) return { ok: false, stage: 'tts', reason: `오디오 길이 측정 실패(#${i})`, steps };
    audio.push({ file: out, durationSec: d });
  }
  steps.audio = audio.length;

  // 5) 조립
  log.info('영상 조립… (ffmpeg)');
  const { videoFile } = await assemble(script, { backgrounds: bgSpec, overlays, audio, cfg });
  steps.video = videoFile;

  // 6) 게이트
  const gate = runGate(videoFile, cfg);
  steps.gate = gate;
  if (!gate.ok) return { ok: false, stage: 'gate', videoFile, gate, reason: '영상 게이트 실패', steps };
  return { ok: true, videoFile, gate, steps };
}
