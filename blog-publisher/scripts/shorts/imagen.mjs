/**
 * shorts/imagen.mjs — Vertex AI 배경 이미지 생성 (Gemini 2.5 Flash Image)
 *
 * 카드마다 주제-맞춤 배경 이미지를 생성해 "단조로운 그라데이션" 문제를 해결.
 * 기존 GSC 서비스계정(~/.secrets/gsc-sa.json, cloud-platform 스코프)을 TTS 와 동일하게
 * 재사용 — 새 자격증명 불필요.
 *
 * 모델: gemini-2.5-flash-image(generateContent, IMAGE 모달리티). 이 프로젝트에서 Imagen
 * (imagegeneration@/imagen-3.0-*)은 Model Garden 게이팅으로 404 지만 Gemini 이미지생성은
 * 서비스계정으로 바로 됨(실측 2026-07-13). 응답 이미지는 임의 비율 → ffmpeg 에서 9:16 커버크롭.
 *
 * ⚠ 사전조건(1회): aiplatform.googleapis.com 사용설정 + 서비스계정에 roles/aiplatform.user.
 * 미충족 시 403/404 → 명확한 에러(호출자가 그라데이션 폴백).
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { GoogleAuth } from 'google-auth-library';
import { expandHome } from './lib.mjs';

let _client = null;
async function token(keyFile) {
  if (!_client) _client = new GoogleAuth({ keyFile, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const t = (await (await _client.getClient()).getAccessToken()).token;
  if (!t) throw new Error('access token 발급 실패');
  return t;
}

/** 프롬프트 정리 — 간결·긍정형(과한 부정문은 SAFETY 오탐 유발). 세로 여백 확보. */
export function refinePrompt(p) {
  const base = (p || '').trim() || 'abstract technology background, glowing particles, dark navy and purple gradient';
  return `${base}. Cinematic lighting, clean minimal composition, dark moody tones, empty central space, no text.`;
}

/** SAFETY 오탐 시 쓸 안전한 추상 배경 프롬프트(주제 무관, 톤만 유지). */
const SAFE_FALLBACK = 'Abstract dark navy and deep purple gradient with soft glowing particles and gentle light streaks, minimal, cinematic, empty central space, no text.';

/**
 * 배경 이미지 1장 생성 → outPath(png). 실패 시 {ok:false, error}.
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function generateImage(prompt, outPath, cfg) {
  const ic = cfg.imagen || {};
  const keyFile = expandHome(ic.key_file || cfg.tts?.google?.key_file || '~/.secrets/gsc-sa.json');
  let sa;
  try { sa = JSON.parse(readFileSync(keyFile, 'utf8')); }
  catch { return { ok: false, error: `서비스계정 키 없음: ${keyFile}` }; }
  const pid = ic.project_id || sa.project_id;
  const loc = ic.location || 'us-central1';
  const model = ic.model || 'gemini-2.5-flash-image';
  let tok;
  try { tok = await token(keyFile); } catch (e) { return { ok: false, error: `인증 실패: ${e.message}` }; }

  // Gemini 이미지생성(generateContent). 세로 구도는 프롬프트로 유도하고 렌더 단계서 커버크롭.
  const url = `https://${loc}-aiplatform.googleapis.com/v1/projects/${pid}/locations/${loc}/publishers/google/models/${model}:generateContent`;
  const ratio = ic.aspect_ratio || '9:16';

  async function callOnce(promptText) {
    const body = {
      contents: [{ role: 'user', parts: [{ text: `Generate a ${ratio} vertical background image. ${promptText}` }] }],
      generationConfig: { responseModalities: ['IMAGE'] },
    };
    let res;
    try { res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
    catch (e) { return { httpError: `네트워크 오류: ${e.message}` }; }
    if (res.status !== 200) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); if (j.error?.message) msg += ` — ${j.error.message.slice(0, 200)}`; } catch {}
      return { httpError: msg };
    }
    let j;
    try { j = await res.json(); } catch { return { httpError: '응답 파싱 실패' }; }
    const parts = j.candidates?.[0]?.content?.parts || [];
    const b64 = parts.find(p => p.inlineData?.data)?.inlineData?.data;
    if (b64) return { b64 };
    return { reason: String(j.candidates?.[0]?.finishReason || j.promptFeedback?.blockReason || '이미지 없음') };
  }

  // 1차: 주제 프롬프트 / 2차(SAFETY·빈응답): 안전 추상 배경으로 재시도
  let r = await callOnce(refinePrompt(prompt));
  if (r.httpError) return { ok: false, error: r.httpError };
  if (!r.b64) r = await callOnce(SAFE_FALLBACK);
  if (r.httpError) return { ok: false, error: r.httpError };
  if (!r.b64) return { ok: false, error: r.reason || '이미지 없음' };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, Buffer.from(r.b64, 'base64'));
  return { ok: true };
}

export function imagenEnabled(cfg) {
  return !!(cfg.imagen && cfg.imagen.enabled);
}
